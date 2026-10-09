/* Offline UI regression suite. Run: node tests/investigation-ui.cjs
 * Requires the preinstalled playwright package and /usr/bin/chromium.
 * Substantive game actions and deduction decisions use real button clicks.
 * Dialogue animation is drained deterministically through the public script scope.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(__dirname, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const report = { startedAt: new Date().toISOString(), tests: [], statistics: null };
const baseUrl = pathToFileURL(path.join(root, 'index.html')).href;
let browser;

function countContent(original) {
  const game = fs.readFileSync(path.join(root, original ? 'original/game.js' : 'game.js'), 'utf8');
  const context = vm.createContext({});
  if (!original) vm.runInContext(fs.readFileSync(path.join(root, 'extension-data.js'), 'utf8'), context);
  vm.runInContext(game.slice(0, game.indexOf('const sceneById')), context);
  return vm.runInContext(`(() => {
    const sceneResults = scenes.map(scene => {
      const actions = Object.values(scene.actions).flat();
      function countLines(value) {
        if (!value || typeof value !== 'object') return 0;
        if (typeof value.speaker === 'string' && typeof value.text === 'string') return 1;
        return Object.values(value).reduce((sum, child) => sum + countLines(child), 0);
      }
      return { id: scene.id, actions: actions.length, observations: scene.actions.look.length,
        decisions: actions.filter(action => action.choices).length, dialogueLines: countLines(scene) };
    });
    const total = key => sceneResults.reduce((sum, scene) => sum + scene[key], 0);
    return { scenes: sceneResults.length, actions: total('actions'), observations: total('observations'),
      decisions: total('decisions'), dialogueLines: total('dialogueLines'), details: sceneResults };
  })()`, context);
}

async function newPage(viewport = { width: 1365, height: 900 }) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
  await page.goto(baseUrl);
  await page.waitForFunction(() => typeof getCaseSnapshot === 'function');
  return page;
}

async function drain(page) {
  return page.evaluate(() => {
    let steps = 0;
    while (steps++ < 1500) {
      if (document.querySelector('#deduction-dialog')?.open || state.finished) break;
      if (prologueActive) advancePrologue();
      else if (!dom.chapterCard.hidden) continueFromChapterCard();
      else if (dialogueBusy) { finishTyping(); advanceDialogue(); }
      else break;
    }
    if (steps >= 1500) throw new Error('Dialogue did not settle');
    return { steps, sceneId: state.currentScene, busy: dialogueBusy,
      decision: Boolean(document.querySelector('#deduction-dialog')?.open) };
  });
}

async function begin(page) {
  await page.locator('#start-button').click();
  await drain(page);
  assert.equal(await page.evaluate(() => state.currentScene), 'dock');
}

async function model(page) {
  return page.evaluate(() => {
    const scene = sceneById[state.currentScene];
    return { id: scene.id, next: scene.next, nextLabel: scene.nextLabel, required: scene.required,
      ready: isSceneReady(scene), finished: state.finished, flags: [...state.flags],
      actions: Object.entries(scene.actions).flatMap(([verb, targets]) => targets.map(target => ({
        verb, id: target.id, label: target.label, flag: target.flag,
        available: targetIsAvailable(target), seen: state.seen.includes(seenKey(scene.id, verb, target.id)),
        solved: Boolean(target.flag && hasFlag(target.flag)),
        choices: target.choices?.map(choice => ({ id: choice.id, label: choice.label, correct: choice.correct,
          sufficient: (choice.requires || []).every(hasFlag), requires: choice.requires || [] }))
      }))) };
  });
}

async function action(page, target) {
  assert.equal(await page.evaluate(() => dialogueBusy), false, 'Actions require settled dialogue');
  if (await page.locator('#command-panel').isHidden()) await page.locator('#command-toggle').click();
  if (await page.locator('#command-verbs-level').isHidden()) await page.locator('#command-back').click();
  await page.locator(`button[data-verb="${target.verb}"]`).click();
  await page.locator('#target-list').getByRole('button', { name: target.label, exact: true }).click();
}

async function nextScene(page) {
  const current = await model(page);
  if (await page.locator('#command-panel').isHidden()) await page.locator('#command-toggle').click();
  if (await page.locator('#command-verbs-level').isHidden()) await page.locator('#command-back').click();
  await page.locator('button[data-verb="move"]').click();
  await page.locator('#target-list .is-next').click();
  await drain(page);
  return current;
}

async function decide(page, choice) {
  await page.locator('#deduction-choices').getByRole('button', { name: choice.label, exact: true }).click();
  await drain(page);
}

async function walkAll(page, options = {}) {
  const traversed = [];
  let actionCount = 0;
  let decisionCount = 0;
  for (let sceneStep = 0; sceneStep < 50; sceneStep++) {
    await drain(page);
    const initial = await model(page);
    if (initial.finished) return { traversed, actionCount, decisionCount };
    assert(!traversed.includes(initial.id), `Scene cycle at ${initial.id}`);
    traversed.push(initial.id);
    // Re-scan after each action so conditional actions unlocked by prior evidence are exercised.
    for (let step = 0; step < 300; step++) {
      const current = await model(page);
      const target = current.actions.find(item => item.available && !item.choices && !item.seen)
        || current.actions.find(item => item.available && item.choices && !item.solved
          && item.choices.some(choice => choice.correct && choice.sufficient));
      if (!target) break;
      await action(page, target);
      actionCount++;
      await drain(page);
      if (target.choices) {
        assert(await page.locator('#deduction-dialog').isVisible(), `Decision not shown: ${current.id}/${target.id}`);
        await decide(page, target.choices.find(choice => choice.correct && choice.sufficient));
        decisionCount++;
        assert((await model(page)).flags.includes(target.flag), `Correct decision not recorded: ${target.id}`);
      }
    }
    const completed = await model(page);
    assert(completed.ready, `Scene blocked: ${completed.id}; missing ${completed.required.filter(flag => !completed.flags.includes(flag)).join(', ')}`);
    const uncovered = completed.actions.filter(item => item.available && !item.seen);
    assert.equal(uncovered.length, 0, `Unvisited actions in ${completed.id}: ${uncovered.map(item => item.id)}`);
    if (options.onScene) await options.onScene(page, completed);
    await nextScene(page);
  }
  throw new Error('Too many scenes without ending');
}

async function test(name, run) {
  const start = Date.now();
  try {
    const detail = await run();
    report.tests.push({ name, pass: true, milliseconds: Date.now() - start, detail });
    console.log(`PASS ${name}: ${JSON.stringify(detail || {})}`);
  } catch (error) {
    report.tests.push({ name, pass: false, milliseconds: Date.now() - start, error: error.stack });
    console.error(`FAIL ${name}: ${error.stack}`);
  }
  fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(report, null, 2));
}

async function run() {
  report.statistics = { baseline: countContent(true), expanded: countContent(false) };
  console.log('CONTENT', JSON.stringify(report.statistics));
  assert(report.statistics.expanded.scenes > report.statistics.baseline.scenes, 'New scenes must exist');
  assert(report.statistics.expanded.actions > report.statistics.baseline.actions, 'New actions must exist');
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });

  await test('all expanded scenes and actions reach ending', async () => {
    const page = await newPage();
    await begin(page);
    const result = await walkAll(page);
    assert.equal(result.traversed.length, report.statistics.expanded.scenes);
    assert.equal(result.actionCount, report.statistics.expanded.actions - 1);
    assert.equal(result.decisionCount, report.statistics.expanded.decisions);
    assert(await page.locator('#ending-screen').isVisible());
    assert.equal(await page.evaluate(() => getLookCount()), report.statistics.expanded.observations - 1);
    assert.equal(await page.locator('#ending-count').textContent(), String(report.statistics.expanded.observations - 1));
    assert.deepEqual(page.errors, []);
    await page.screenshot({ path: path.join(artifacts, 'expanded-ending.png') });
    await page.reload();
    await page.locator('#continue-button').click();
    assert(await page.locator('#ending-screen').isVisible(), 'Finished save should resume at ending');
    await page.locator('#return-office').click();
    await drain(page);
    assert.equal(await page.evaluate(() => state.currentScene), 'office');
    assert.equal(await page.evaluate(() => state.finished), false);
    await page.context().close();
    return result;
  });

  await test('deduction feedback, deferral, keyboard isolation and reload recovery', async () => {
    const page = await newPage();
    await begin(page);
    // The first reachable decision must be testable before collecting its evidence.
    let candidate;
    for (let i = 0; i < 30; i++) {
      const current = await model(page);
      candidate = current.actions.find(item => item.available && item.choices && !item.solved);
      if (candidate) break;
      // Progress only this scene's actions, then enter the next scene.
      for (let j = 0; j < 250; j++) {
        const state = await model(page);
        const item = state.actions.find(action => action.available && !action.seen && !action.choices);
        if (!item) break;
        await action(page, item); await drain(page);
      }
      assert((await model(page)).ready, 'Could not reach an unguarded decision');
      await nextScene(page);
    }
    assert(candidate, 'At least one reachable deduction is required');
    const sceneId = await page.evaluate(() => state.currentScene);
    const right = candidate.choices.find(choice => choice.correct);
    const wrong = candidate.choices.find(choice => !choice.correct && choice.sufficient);
    assert(right && wrong, 'Decision requires a correct and incorrect choice');
    assert(!right.sufficient, 'First decision should have uncollected evidence for no-evidence test');

    await action(page, candidate); await drain(page);
    const flagsBefore = await page.evaluate(() => [...state.flags]);
    const historyBefore = await page.evaluate(() => state.history.length);
    // Focusing the dialog itself prevents Enter from choosing the default button.
    await page.locator('#deduction-dialog').evaluate(node => { node.tabIndex = -1; node.focus(); });
    await page.keyboard.press('Enter');
    assert(await page.locator('#deduction-dialog').isVisible(), 'Enter leaked through an open modal');
    assert.equal(await page.evaluate(() => state.history.length), historyBefore);
    await page.locator('#deduction-back').click();
    assert.deepEqual(await page.evaluate(() => state.flags), flagsBefore);
    assert(await page.locator('#deduction-dialog').isHidden());
    assert.equal(await page.evaluate(() => dialogueBusy), false);

    await action(page, candidate); await drain(page);
    await decide(page, right);
    assert(!(await model(page)).flags.includes(candidate.flag), 'No-evidence answer must not solve deduction');
    assert.match(await page.locator('#dialogue-text').textContent(), /まだ確かめていない/);
    await action(page, candidate); await drain(page);
    await decide(page, wrong);
    assert(!(await model(page)).flags.includes(candidate.flag), 'Wrong answer must not solve deduction');
    const wrongFeedback = await page.locator('#dialogue-text').textContent();
    assert(wrongFeedback.trim().length > 0, 'Wrong answer must explain why');

    await action(page, candidate); await drain(page);
    await page.screenshot({ path: path.join(artifacts, 'deduction-desktop.png') });
    const saved = await page.evaluate(() => ({ flags: [...state.flags], seen: [...state.seen] }));
    await page.reload();
    await page.locator('#continue-button').click(); await drain(page);
    assert.equal(await page.evaluate(() => state.currentScene), sceneId);
    assert.deepEqual(await page.evaluate(() => state.flags), saved.flags);
    assert.deepEqual(await page.evaluate(() => state.seen), saved.seen);
    await action(page, candidate); await drain(page);
    assert(await page.locator('#deduction-dialog').isVisible(), 'Unresolved decision must reopen after reload');
    await page.locator('#deduction-back').click();

    // Collect scene evidence through real clicks, then retry the same decision successfully.
    for (let i = 0; i < 150; i++) {
      const now = await model(page);
      const item = now.actions.find(action => action.available && !action.seen && !action.choices);
      if (!item) break;
      await action(page, item); await drain(page);
    }
    const retry = (await model(page)).actions.find(item => item.id === candidate.id && item.verb === candidate.verb);
    assert(retry.choices.find(choice => choice.correct).sufficient);
    await action(page, retry); await drain(page);
    await decide(page, retry.choices.find(choice => choice.correct));
    assert((await model(page)).flags.includes(candidate.flag), 'Retry should solve deduction');
    assert.deepEqual(page.errors, []);
    await page.context().close();
    return { sceneId, target: candidate.id, wrongFeedback, deferralPreservesFlags: true, reloadPreservesProgress: true };
  });

  await test('chapter resolution resumes after reload and buttons activate with Enter', async () => {
    const page = await newPage();
    await begin(page);
    await page.locator('#command-toggle').focus();
    await page.keyboard.press('Enter');
    assert(await page.locator('#command-panel').isVisible(), 'Enter should activate command button');
    await page.locator('button[data-verb="look"]').focus();
    await page.keyboard.press('Enter');
    assert(await page.locator('#command-targets-level').isVisible(), 'Enter should activate verb button');
    await page.locator('#command-close').click();
    async function drainToCard() {
      return page.evaluate(() => {
        for (let i = 0; i < 1000; i++) {
          if (!dom.chapterCard.hidden || dom.deduction.open || !dialogueBusy) break;
          finishTyping(); advanceDialogue();
        }
        return { card: !dom.chapterCard.hidden, decision: dom.deduction.open };
      });
    }
    let reachedResolution = false;
    for (let i = 0; i < 250; i++) {
      const now = await model(page);
      const target = now.actions.find(item => item.available && !item.seen && !item.choices)
        || now.actions.find(item => item.available && item.choices && !item.solved
          && item.choices.some(choice => choice.correct && choice.sufficient));
      assert(target, 'Could not trigger first resolution');
      await action(page, target);
      let position = await drainToCard();
      if (position.decision) {
        const choice = target.choices.find(item => item.correct && item.sufficient);
        assert(choice);
        await page.locator('#deduction-choices').getByRole('button', { name: choice.label, exact: true }).click();
        position = await drainToCard();
      }
      if (position.card) { reachedResolution = true; break; }
    }
    assert(reachedResolution);
    const resolution = await page.evaluate(() => ({ id: state.currentScene,
      pending: state.pendingSceneResolution, lines: sceneById[state.currentScene].readyLines }));
    assert.equal(resolution.pending, resolution.id, 'Unread resolution must be persisted');
    await page.reload();
    await page.locator('#continue-button').click();
    assert.equal(await page.locator('#dialogue-text').textContent(), resolution.lines[0].text,
      'Reload should replay the revelation, not the scene resume line');
    await drain(page);
    assert.equal(await page.evaluate(() => state.pendingSceneResolution), null);
    const tail = await page.evaluate(count => state.history.slice(-count), resolution.lines.length);
    assert.deepEqual(tail, resolution.lines);
    assert.deepEqual(page.errors, []);
    await page.context().close();
    return { sceneId: resolution.id, revelationLinesReplayed: resolution.lines.length, keyboardButtonsActivate: true };
  });

  await test('mid-dialogue save, original edition, and independent save keys', async () => {
    const expanded = await newPage();
    await begin(expanded);
    const target = (await model(expanded)).actions.find(item => !item.choices && item.flag && item.available);
    await action(expanded, target);
    assert.equal(await expanded.evaluate(() => dialogueBusy), true);
    const beforeReload = await expanded.evaluate(() => ({ flags: [...state.flags], seen: [...state.seen], key: saveKey }));
    await expanded.reload();
    await expanded.locator('#continue-button').click(); await drain(expanded);
    assert.deepEqual(await expanded.evaluate(() => state.flags), beforeReload.flags);
    assert.deepEqual(await expanded.evaluate(() => state.seen), beforeReload.seen);
    const expandedSave = await expanded.evaluate(() => localStorage.getItem(saveKey));
    const original = await expanded.context().newPage();
    original.errors = []; original.on('pageerror', error => original.errors.push(error.message));
    await original.goto(pathToFileURL(path.join(root, 'original/index.html')).href);
    await original.waitForFunction(() => typeof getCaseSnapshot === 'function');
    assert.notEqual(await original.evaluate(() => saveKey), beforeReload.key);
    await begin(original);
    const result = await walkAll(original);
    assert.equal(result.traversed.length, report.statistics.baseline.scenes);
    assert.equal(result.actionCount, report.statistics.baseline.actions);
    assert(await original.locator('#ending-screen').isVisible());
    assert.equal(await expanded.evaluate(() => localStorage.getItem(saveKey)), expandedSave, 'Original must not replace expanded save');
    assert.deepEqual(original.errors, []);
    assert.deepEqual(expanded.errors, []);
    await expanded.context().close();
    return { midDialogueProgressRetained: true, independentSaveKeys: true, originalWalkthrough: result };
  });

  await test('portrait, landscape and notes modal layout', async () => {
    const page = await newPage({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(artifacts, 'title-portrait.png') });
    assert(await page.locator('#start-button').isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Title overflows portrait width');
    await page.locator('#start-button').click();
    await page.screenshot({ path: path.join(artifacts, 'game-portrait.png') });
    const portraitGate = await page.locator('.orientation-gate').isVisible();
    await page.setViewportSize({ width: 844, height: 390 });
    await drain(page);
    assert(await page.locator('.orientation-gate').isHidden());
    assert(await page.locator('#command-toggle').isVisible());
    await page.screenshot({ path: path.join(artifacts, 'game-landscape.png') });
    await page.locator('#command-toggle').click();
    await page.locator('button[data-verb="look"]').click();
    await page.screenshot({ path: path.join(artifacts, 'commands-landscape.png') });
    await page.locator('#target-list button').last().click(); await drain(page);
    await page.locator('#notes-button').click();
    assert(await page.locator('#notes-dialog').isVisible());
    const history = await page.evaluate(() => state.history.length);
    await page.locator('#notes-dialog').evaluate(node => { node.tabIndex = -1; node.focus(); });
    await page.keyboard.press('Enter');
    assert(await page.locator('#notes-dialog').isVisible());
    assert.equal(await page.evaluate(() => state.history.length), history);
    await page.screenshot({ path: path.join(artifacts, 'notes-landscape.png') });
    await page.locator('#resume-button').click();
    assert.deepEqual(page.errors, []);
    await page.context().close();
    return { portraitGate, landscapeCommandsAccessible: true, notesKeyboardIsolated: true };
  });

  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(report, null, 2));
  await browser.close();
  if (report.tests.some(item => !item.pass)) process.exitCode = 1;
}
run().catch(async error => { console.error(error.stack); report.launchOrSetupFailure = error.stack; fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(report, null, 2)); if (browser) await browser.close(); process.exitCode = 1; });
