# Investigation regression tests

## Verified without rendering

Run:

```sh
node tests/investigation-engine.cjs
```

This executes the actual `game.js` and `extension-data.js` in a Node VM with a small, explicit DOM stub. Actions call the actual registered button callbacks. It verifies progression and saved state; it does not claim browser, CSS, touch, audio, accessibility, or native keyboard/focus verification.

The current run passes 10 groups:

- All 13 expanded scenes and all actions reachable on one branch reach the ending
- Both final-report branches, their distinct receipt and ending, and all 207 actions across both paths
- Minimal prerequisite-only route: 44 actions, no dependency on missed optional earlier clues
- Eight wrong choices, four insufficient-evidence attempts, five deferrals, and successful retries
- Unresolved retries use the original question rather than solved-repeat dialogue
- Mid-dialogue and unresolved-decision reload preserve progress
- Reload before a chapter revelation replays its four resolution lines
- Modal keyboard guards and the native-button bypass in the engine handler
- WebMCP hypothesis listing, invalid-choice rejection, and modal isolation
- Full original edition, separate save keys, original file preservation, and reference integrity

Machine-readable results: `artifacts/engine-results.json`.

Counts: original 9 scenes / 156 actions / 344 dialogue entries; expanded 13 scenes / 207 authored actions / 569 dialogue entries / 5 decisions. There are 104 authored observations but one mutually exclusive receipt per route; both routes can reach the displayed 103/103.

## Browser suite prepared but not run successfully

Run in an environment that permits Chromium:

```sh
node tests/investigation-ui.cjs
```

Uses the installed Playwright package, `/usr/bin/chromium`, and local file URLs. It clicks actual action and decision buttons, drains dialogue deterministically, checks save/reload and keyboard behavior, and captures portrait/landscape screenshots under `artifacts/`.

In the current environment, Chromium aborts before page creation with `socket() failed: Operation not permitted` in `process_singleton_posix.cc`. No page rendering or screenshots succeeded. Browser layout, real pointer/keyboard interaction, touch, audio, and accessibility remain unverified. The UI suite was syntax-checked only.
