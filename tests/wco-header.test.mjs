import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Installed desktop app with the title bar hidden (window-controls-overlay): the header's right padding must clear the
// caption buttons. studio.css loads after app.css and resets .top padding, so the overlay rule has to be the last word.
const app = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const studio = readFileSync(new URL('../public/studio.css', import.meta.url), 'utf8');
const WCO = /@media \(display-mode: window-controls-overlay\) \{\s*\.top \{ padding-right: calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\) \+ 12px\); \}/;

test('window-controls-overlay: the caption-button padding comes after every .top padding rule', () => {
  const at = studio.search(WCO);
  assert.ok(at >= 0, 'studio.css has the overlay padding rule');
  const lastPadding = [...studio.matchAll(/\.top \{[^}]*padding(?:-inline|-right)?\s*:/g)].map((m) => m.index).filter((i) => i !== at + studio.slice(at).indexOf('.top {'));
  assert.ok(lastPadding.every((i) => i < at), 'no .top padding rule follows it in studio.css');
  assert.ok(!WCO.test(app), 'app.css (loaded first) does not hold a copy that studio.css would override');
});
