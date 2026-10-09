/* Deterministic engine regression suite, with an explicit DOM stub.
 * This executes the unmodified game.js, its real button-event callbacks, and save
 * code. It does NOT render a browser or verify CSS, touch, accessibility, audio,
 * focus behavior, or native keyboard activation. Run: node tests/investigation-engine.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const out = path.join(__dirname, 'artifacts');
fs.mkdirSync(out, { recursive: true });
const results = { mode: 'Unmodified engine in Node VM with DOM stubs; no rendering', tests: [], browser: {
  verified: false, launch: "playwright.chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })",
  blocker: 'Chromium aborted before page creation: process_singleton_posix.cc socket() failed: Operation not permitted (SIGABRT). No browser screenshot or layout result exists.'
} };

class StubElement {
  constructor(tagName = 'div', attrs = {}) {
    this.tagName = tagName.toUpperCase(); this.id = attrs.id || ''; this.attrs = attrs;
    this.hidden = 'hidden' in attrs; this.disabled = false; this.open = false;
    this.children = []; this.handlers = {}; this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = value; } };
    this._text = ''; this.className = attrs.class || '';
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(' ').trim(); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, value) => { const add = value === undefined ? !this.classList.contains(name) : value; add ? this.classList.add(name) : this.classList.remove(name); return add; }
    };
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) this.dataset[key.slice(5)] = value;
  }
  get textContent() { return this._text + this.children.map(child => child.textContent || '').join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...elements) { this.children.push(...elements); }
  replaceChildren(...elements) { this._text = ''; this.children = [...elements]; }
  setAttribute(key, value) { this.attrs[key] = value; }
  removeAttribute(key) { delete this.attrs[key]; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  dispatch(type, options = {}) { const event = { target: this, prevented: false, preventDefault() { this.prevented = true; }, ...options }; for (const handler of this.handlers[type] || []) handler(event); return event; }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  play() { return Promise.resolve(); }
  pause() {}
  closest(selector) { return selector.split(',').map(x => x.trim().toUpperCase()).includes(this.tagName) ? this : null; }
}

function createHarness(original = false, saved = new Map()) {
  const folder = original ? path.join(root, 'original') : root;
  const html = fs.readFileSync(path.join(folder, 'index.html'), 'utf8');
  const elements = [];
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^<>]*)>/gi)) {
    const attrs = {};
    for (const attr of match[2].matchAll(/([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[attr[1]] = attr[2] ?? attr[3] ?? attr[4] ?? '';
    elements.push(new StubElement(match[1], attrs));
  }
  const registered = {};
  const document = new StubElement('document');
  document.querySelectorAll = selector => elements.filter(element => selector[0] === '#' ? element.id === selector.slice(1) : selector[0] === '.' ? element.classList.contains(selector.slice(1)) : element.tagName === selector.toUpperCase());
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  document.createElement = tag => new StubElement(tag);
  document.createTextNode = text => { const node = new StubElement('#text'); node.textContent = text; return node; };
  document.documentElement = new StubElement('html');
  document.modelContext = { registerTool(tool) { registered[tool.name] = tool; } };
  let timer = 0;
  const context = vm.createContext({ document, console, AbortController, Date,
    window: { setTimeout: () => ++timer, setInterval: () => ++timer, clearInterval() {}, matchMedia: () => ({ matches: true }) },
    localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    screen: { orientation: {} }
  });
  if (!original) vm.runInContext(fs.readFileSync(path.join(root, 'extension-data.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(folder, 'game.js'), 'utf8'), context, { filename: original ? 'original/game.js' : 'game.js' });
  const run = code => vm.runInContext(code, context);
  const read = code => JSON.parse(JSON.stringify(run(code)));
  function click(selector) { const node = document.querySelector(selector); assert(node, `Missing element ${selector}`); assert(!node.disabled, `Disabled element ${selector}`); node.click(); }
  function drain(stopAtCard = false) {
    return run(`(() => { let count = 0; while (++count < 3000) {
      if (state.finished || document.querySelector('#deduction-dialog')?.open) break;
      if (${stopAtCard} && !dom.chapterCard.hidden) break;
      if (prologueActive) advancePrologue();
      else if (!dom.chapterCard.hidden) continueFromChapterCard();
      else if (dialogueBusy) { finishTyping(); advanceDialogue(); }
      else break;
    } if (count >= 3000) throw new Error('Dialogue did not settle'); return count; })()`);
  }
  function actions() { return read(`Object.entries(sceneById[state.currentScene].actions).flatMap(([verb, targets]) => targets.map(target => ({ ...target, verb,
    available: targetIsAvailable(target), seen: state.seen.includes(seenKey(state.currentScene, verb, target.id)), solved: Boolean(target.flag && hasFlag(target.flag)),
    choices: target.choices?.map(choice => ({ ...choice, sufficient: (choice.requires || []).every(hasFlag) })) })))`); }
  function action(target) {
    assert.equal(run('dialogueBusy'), false); assert.equal(run('prologueActive'), false);
    const button = run(`setActiveVerb(${JSON.stringify(target.verb)}); dom.targetList.children.find(button => button.textContent === ${JSON.stringify(target.label)})`);
    assert(button, `Missing target button ${target.id}`); assert(!button.disabled, `Disabled target ${target.id}`); button.click();
    if (target.choices && !target.solved && target.lines?.length) assert.equal(run('dom.dialogueText.textContent'), target.lines[0].text, `Unresolved retry must show original question, not solved repeat: ${target.id}`);
  }
  function choose(choice) { const button = run(`dom.deductionChoices.children.find(button => button.textContent === ${JSON.stringify(choice.label)})`); assert(button); button.click(); }
  function next() { run('setActiveVerb("move")'); const button = run('dom.targetList.children.find(button => button.classList.contains("is-next"))'); assert(button); button.click(); drain(); }
  return { run, read, click, drain, actions, action, choose, next, context, document, registered, saved, original };
}

function countContent(original) {
  const h = createHarness(original);
  return h.read(`(() => {
    function lines(value) {
      if (!value || typeof value !== 'object') return 0;
      if (typeof value.speaker === 'string' && typeof value.text === 'string') return 1;
      return Object.values(value).reduce((sum, item) => sum + lines(item), 0);
    }
    const details = scenes.map(scene => ({ id: scene.id, actions: Object.values(scene.actions).flat().length,
      observations: scene.actions.look.length, decisions: Object.values(scene.actions).flat().filter(target => target.choices).length,
      dialogueLines: lines(scene) }));
    const total = key => details.reduce((sum, scene) => sum + scene[key], 0);
    return { scenes: scenes.length, actions: total('actions'), observations: total('observations'), decisions: total('decisions'), dialogueLines: total('dialogueLines'), details };
  })()`);
}

function begin(h) { h.click('#start-button'); h.drain(); assert.equal(h.run('state.currentScene'), 'dock'); }
function walk(h, { adverse = false, stopAfterScene = false, preferredReport = 'prioritize_care' } = {}) {
  const traversed = [], checks = { actions: 0, decisions: 0, wrongAnswers: 0, missingEvidence: 0, deferrals: 0 };
  for (let sceneStep = 0; sceneStep < 50; sceneStep++) {
    h.drain();
    if (h.run('state.finished')) return { traversed, ...checks };
    const sceneId = h.run('state.currentScene'); assert(!traversed.includes(sceneId), `Cycle: ${sceneId}`); traversed.push(sceneId);
    if (adverse) {
      // Before collecting any scene evidence, attempt visible unsupported conclusions.
      for (const target of h.actions().filter(target => target.available && target.choices && !target.solved)) {
        const correct = target.choices.find(choice => choice.correct);
        if (!correct?.sufficient) {
          h.action(target); h.drain(); assert(h.run('dom.deduction.open'));
          h.choose(correct); h.drain();
          assert(!h.run(`hasFlag(${JSON.stringify(target.flag)})`), `Premature deduction solved ${sceneId}/${target.id}`);
          assert.match(h.run('dom.dialogueText.textContent'), /まだ確かめていない/); checks.missingEvidence++;
        }
      }
    }
    for (let step = 0; step < 500; step++) {
      const actions = h.actions();
      const target = actions.find(item => item.available && !item.choices && !item.seen)
        || actions.find(item => item.available && item.choices && !item.solved && item.choices.some(choice => choice.correct && choice.sufficient));
      if (!target) break;
      h.action(target); h.drain(); checks.actions++;
      if (target.choices) {
        assert(h.run('dom.deduction.open'), `Missing dialog ${sceneId}/${target.id}`);
        if (adverse) {
          const flags = h.read('state.flags');
          h.click('#deduction-back'); checks.deferrals++;
          assert.deepEqual(h.read('state.flags'), flags);
          h.action(target); h.drain();
          for (const wrong of target.choices.filter(choice => !choice.correct && choice.sufficient)) {
            h.choose(wrong); h.drain(); checks.wrongAnswers++;
            assert(!h.run(`hasFlag(${JSON.stringify(target.flag)})`), `Wrong answer solved ${target.id}`);
            assert(h.run('dom.dialogueText.textContent').trim(), `Wrong answer lacks feedback ${target.id}`);
            h.action(target); h.drain();
          }
        }
        h.choose(target.choices.find(choice => choice.correct && choice.sufficient && choice.id === preferredReport) || target.choices.find(choice => choice.correct && choice.sufficient)); h.drain(); checks.decisions++;
        assert(h.run(`hasFlag(${JSON.stringify(target.flag)})`), `Correct answer failed ${target.id}`);
      }
    }
    assert(h.run('isSceneReady(sceneById[state.currentScene])'), `Blocked scene ${sceneId}: ${h.read('sceneById[state.currentScene].required.filter(flag => !hasFlag(flag))')}`);
    assert.equal(h.actions().filter(target => target.available && !target.seen).length, 0, `Unvisited ${sceneId}`);
    if (stopAfterScene) return { traversed, ...checks };
    h.next();
  }
  throw new Error('No ending');
}

function test(name, fn) {
  try { const detail = fn(); results.tests.push({ name, pass: true, detail }); console.log('PASS', name, JSON.stringify(detail || {})); }
  catch (error) { results.tests.push({ name, pass: false, error: error.stack }); console.error('FAIL', name, error.stack); }
  fs.writeFileSync(path.join(out, 'engine-results.json'), JSON.stringify(results, null, 2));
}

results.statistics = { baseline: countContent(true), expanded: countContent(false) };
console.log('CONTENT', JSON.stringify(results.statistics));
test('all expanded scenes and actions reach ending through real engine callbacks', () => {
  const h = createHarness(); begin(h); const result = walk(h);
  assert.equal(result.traversed.length, results.statistics.expanded.scenes);
  assert.equal(result.actions, results.statistics.expanded.actions - 1, 'The other report receipt is intentionally exclusive');
  assert.equal(result.decisions, results.statistics.expanded.decisions);
  assert.equal(h.run('getLookCount()'), results.statistics.expanded.observations - 1);
  assert.equal(h.run('state.seen.length'), results.statistics.expanded.actions - 1);
  assert(h.run('state.finished')); assert(!h.run('dom.ending.hidden'));
  assert.equal(h.run('state.history.length'), 250);
  const reload = createHarness(false, h.saved); reload.click('#continue-button'); assert(reload.run('state.finished'));
  reload.click('#return-office'); reload.drain(); assert.equal(reload.run('state.currentScene'), 'office'); assert.equal(reload.run('state.finished'), false);
  return result;
});
test('both report branches expose their receipt and distinct ending response', () => {
  const seen = new Set(); const outcomes = [];
  for (const [choice, flag, receipt, excluded] of [
    ['prioritize_care', 'report_care', 'care_receipt', 'verification_receipt'],
    ['prioritize_verification', 'report_verify', 'verification_receipt', 'care_receipt']
  ]) {
    const h = createHarness(); begin(h); const result = walk(h, { preferredReport: choice });
    assert(h.run(`hasFlag(${JSON.stringify(flag)})`));
    assert(h.read('state.seen').includes(`office:look:${receipt}`));
    assert(!h.read('state.seen').includes(`office:look:${excluded}`));
    h.read('state.seen').forEach(key => seen.add(key));
    assert.equal(h.run('getLookCount()'), h.run('getLookTotal()'), 'All reachable observations must fill the displayed total');
    const ending = h.run('dom.endingNote.textContent');
    const endingNote = h.run(`expansion.endingNotes?.[${JSON.stringify(flag)}]`);
    if (endingNote) assert(ending.includes(endingNote));
    outcomes.push({ choice, actions: result.actions, observations: h.run('getLookCount()'), displayedTotal: h.run('getLookTotal()'), ending });
  }
  assert.equal(seen.size, results.statistics.expanded.actions, 'Both paths together should cover every authored action');
  assert.notEqual(outcomes[0].ending, outcomes[1].ending, 'Final report should change the closing response');
  return { uniqueActionsAcrossBranches: seen.size, outcomes };
});
test('minimal prerequisite-only route reaches ending without missable earlier evidence', () => {
  const h = createHarness(); begin(h); const traversed = []; let actionsTaken = 0;
  while (!h.run('state.finished')) {
    const sceneId = h.run('state.currentScene'); assert(!traversed.includes(sceneId)); traversed.push(sceneId);
    const availableData = h.actions(); const schedule = []; const scheduled = new Set(); const resolving = new Set();
    function requireFlag(flag) {
      if (h.run(`hasFlag(${JSON.stringify(flag)})`)) return;
      if (resolving.has(flag)) throw new Error(`Cyclic prerequisite ${sceneId}/${flag}`);
      resolving.add(flag);
      const target = availableData.find(item => item.flag === flag || item.choices?.some(choice => choice.correct && choice.flag === flag));
      assert(target, `Required flag ${flag} cannot be acquired in ${sceneId}; likely missed an optional earlier clue`);
      const key = `${target.verb}:${target.id}`;
      if (!scheduled.has(key)) {
        const conditions = Array.isArray(target.condition) ? target.condition : target.condition ? [target.condition] : [];
        conditions.forEach(requireFlag);
        if (target.choices) {
          const correct = target.choices.find(choice => choice.correct && (target.flag === flag || choice.flag === flag));
          assert(correct, `No correct producer ${sceneId}/${flag}`);
          (correct.requires || []).forEach(requireFlag);
        }
        scheduled.add(key); schedule.push(target);
      }
      resolving.delete(flag);
    }
    h.read('sceneById[state.currentScene].required').forEach(requireFlag);
    for (const target of schedule) {
      const live = h.actions().find(item => item.verb === target.verb && item.id === target.id);
      assert(live.available, `Unavailable required action ${sceneId}/${live.id}`);
      h.action(live); h.drain(); actionsTaken++;
      if (live.choices) { const correct = live.choices.find(choice => choice.correct && choice.sufficient); assert(correct); h.choose(correct); h.drain(); }
    }
    assert(h.run('isSceneReady(sceneById[state.currentScene])'), `Minimal path blocked at ${sceneId}`);
    h.next();
  }
  assert.equal(traversed.length, results.statistics.expanded.scenes);
  return { traversed, actionsTaken, optionalActionsSkipped: results.statistics.expanded.actions - actionsTaken };
});
test('all reachable wrong choices, missing evidence, deferral and retry', () => {
  const h = createHarness(); begin(h); const result = walk(h, { adverse: true });
  assert(result.missingEvidence > 0); assert(result.wrongAnswers > 0); assert(result.deferrals > 0); return result;
});
test('save resumes mid-dialogue, pending decision and unread resolution', () => {
  let h = createHarness(); begin(h);
  const target = h.actions().find(item => item.available && item.flag && !item.choices);
  h.action(target); const snapshot = h.read('({flags: state.flags, seen: state.seen})');
  h = createHarness(false, h.saved); h.click('#continue-button'); h.drain();
  assert.deepEqual(h.read('({flags: state.flags, seen: state.seen})'), snapshot);
  let decision = h.actions().find(item => item.available && item.choices);
  while (!decision) { walk(h, { stopAfterScene: true }); h.next(); decision = h.actions().find(item => item.available && item.choices); }
  assert(decision); h.action(decision); h.drain(); assert(h.run('dom.deduction.open'));
  const pendingSnapshot = h.read('({flags: state.flags, seen: state.seen})');
  h = createHarness(false, h.saved); h.click('#continue-button'); h.drain();
  assert.deepEqual(h.read('({flags: state.flags, seen: state.seen})'), pendingSnapshot);
  h.action(decision); h.drain(); assert(h.run('dom.deduction.open')); h.click('#deduction-back');
  let card = false;
  for (let i = 0; i < 200; i++) {
    const actions = h.actions(); const target = actions.find(item => item.available && !item.seen && !item.choices)
      || actions.find(item => item.available && item.choices && !item.solved && item.choices.some(choice => choice.correct && choice.sufficient));
    assert(target); h.action(target); h.drain(true);
    if (h.run('dom.deduction.open')) { h.choose(target.choices.find(choice => choice.correct && choice.sufficient)); h.drain(true); }
    if (h.run('!dom.chapterCard.hidden')) { card = true; break; }
  }
  assert(card); const reveal = h.read('({id: state.currentScene, pending: state.pendingSceneResolution, lines: sceneById[state.currentScene].readyLines})');
  assert.equal(reveal.id, reveal.pending);
  h = createHarness(false, h.saved); h.click('#continue-button');
  assert.equal(h.run('dom.dialogueText.textContent'), reveal.lines[0].text); h.drain();
  assert.equal(h.run('state.pendingSceneResolution'), null);
  assert.deepEqual(h.read(`state.history.slice(-${reveal.lines.length})`), reveal.lines);
  return { scene: reveal.id, revelationLinesReplayed: reveal.lines.length, midDialogueAndDecisionProgressRetained: true };
});
test('keydown modal guards and button-native-key bypass in engine handler', () => {
  const h = createHarness(); begin(h);
  for (const selector of ['#notes-dialog', '#restart-dialog', '#deduction-dialog']) {
    const modal = h.document.querySelector(selector); modal.showModal(); const before = h.read('({history: state.history.length, scene: state.currentScene})');
    const event = h.document.dispatch('keydown', { key: 'Enter', target: modal });
    assert.equal(event.prevented, false); assert.deepEqual(h.read('({history: state.history.length, scene: state.currentScene})'), before); modal.close();
  }
  for (const key of ['Enter', ' ']) {
    const event = h.document.dispatch('keydown', { key, target: h.document.querySelector('#command-toggle') }); assert.equal(event.prevented, false);
  }
  return { handlerGuardsVerified: true, nativeBrowserActivationNotVerified: true };
});
test('WebMCP exposes hypotheses and blocks action leakage through deduction', () => {
  const h = createHarness(); begin(h);
  let target = h.actions().find(item => item.available && item.choices);
  while (!target) { walk(h, { stopAfterScene: true }); h.next(); target = h.actions().find(item => item.available && item.choices); }
  const before = h.read('state.flags');
  h.action(target); h.drain();
  const snapshot = h.registered.read_case_state.execute();
  assert.equal(snapshot.deduction.id, target.id); assert.equal(snapshot.deduction.choices.length, target.choices.length);
  assert.throws(() => h.registered.choose_case_action.execute({ verb: 'move', targetId: 'next' }), /Resolve or defer/);
  assert.throws(() => h.registered.choose_case_hypothesis.execute({ choiceId: 'not-a-choice' }), /Unknown hypothesis/);
  assert.deepEqual(h.read('state.flags'), before);
  const wrong = target.choices.find(choice => !choice.correct);
  h.registered.choose_case_hypothesis.execute({ choiceId: wrong.id }); h.drain();
  assert(!h.run('dom.deduction.open')); assert(!h.run(`hasFlag(${JSON.stringify(target.flag)})`));
  assert.throws(() => h.registered.choose_case_hypothesis.execute({ choiceId: wrong.id }), /No hypothesis/);
  return { registeredTools: Object.keys(h.registered), unknownChoiceRejected: true, modalActionLeakBlocked: true };
});
test('original edition reaches ending with independent save key', () => {
  const expanded = createHarness(); begin(expanded); const expandedKey = expanded.run('saveKey'), snapshot = expanded.saved.get(expandedKey);
  const h = createHarness(true, expanded.saved); assert.notEqual(h.run('saveKey'), expandedKey); begin(h); const result = walk(h);
  assert.equal(result.traversed.length, results.statistics.baseline.scenes); assert.equal(result.actions, results.statistics.baseline.actions);
  assert.equal(expanded.saved.get(expandedKey), snapshot); assert(h.run('state.finished'));
  return { ...result, separateSaveKeys: [expandedKey, h.run('saveKey')] };
});
test('original edition preserved byte-for-byte apart from relative asset paths', () => {
  const { createHash } = require('node:crypto');
  const commit = '88232aa3535d8c50f156b2f76df019bceda27ff7';
  // Hashes verified against git show for the baseline commit; portable in the ZIP.
  const expected = {"index.html": "08fb905791dc0a954ed83a78c0ed0058f3cb859840edd537cf4a4db49efc7628", "game.js": "6dc5db71a77ce991dedad3ad4d59b1c823e7252c4c8b1b29f0f465956975b0d5", "styles.css": "bd6cbddd63af9b55d42bb2fedb8cf0e9cacdc8bb28168f23fd5413df44f588aa"};
  const files = Object.keys(expected);
  for (const file of files) {
    const copy = fs.readFileSync(path.join(root, 'original', file), 'utf8').replaceAll('../assets/', 'assets/');
    const actual = createHash('sha256').update(copy).digest('hex');
    assert.equal(actual, expected[file], `Original changed: ${file}`);
  }
  return { commit, files, onlyChange: 'Relative assets/ paths adjusted to ../assets/' };
});
test('all chapter links, action IDs, flags and choice evidence resolve', () => {
  const h = createHarness(); const scenes = h.read('scenes'); const ids = new Set(scenes.map(scene => scene.id)); assert.equal(ids.size, scenes.length);
  const flags = new Set(); const requires = [];
  for (const scene of scenes) {
    assert(scene.next === 'ending' || ids.has(scene.next), `Invalid next ${scene.id}`);
    assert(scene.transition && scene.readyLines.length, `Missing resolution ${scene.id}`);
    requires.push(...scene.required);
    for (const [verb, targets] of Object.entries(scene.actions)) {
      const unique = new Set();
      for (const target of targets) {
        assert(!unique.has(target.id), `Duplicate target ${scene.id}/${verb}/${target.id}`); unique.add(target.id);
        if (target.flag) flags.add(target.flag);
        requires.push(...(Array.isArray(target.condition) ? target.condition : target.condition ? [target.condition] : []));
        for (const choice of target.choices || []) { if (choice.flag) flags.add(choice.flag); requires.push(...(choice.requires || [])); }
      }
    }
  }
  for (const flag of requires) assert(flags.has(flag), `Unproducible flag ${flag}`);
  return { scenes: scenes.length, producedFlags: flags.size, prerequisites: requires.length };
});
results.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(out, 'engine-results.json'), JSON.stringify(results, null, 2));
if (results.tests.some(test => !test.pass)) process.exitCode = 1;
