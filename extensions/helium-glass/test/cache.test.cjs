const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../cache.js');
const attrs = Object.fromEntries(['class', 'data-theme', 'data-color-mode', 'data-color-scheme', 'color-scheme'].map(name => [name, null]));
const now = 1800000000000;
const entry = { version: C.VERSION, time: now, html: attrs, body: attrs, mediaDark: false,
  surfaces: [{ selector: 'body', color: { r: 245, g: 246, b: 248, a: 1 } }] };
const settings = { enabled: true, transparency: 65 };
test('cache keys separate origins and paths and exclude queries, fragments and credentials', () => {
  assert.equal(C.pageKey('https://user:pass@example.test/search?q=private#top'), 'https://example.test/search');
  assert.notEqual(C.pageKey('https://example.test/'), C.pageKey('https://example.test/search'));
  assert.equal(C.pageKey('file:///tmp/demo.html?q=x'), 'file:///tmp/demo.html');
  assert.equal(C.pageKey('chrome://flags'), null);
});
test('replay retains original RGB and uses the current transparency strength', () => {
  assert.match(C.css(entry, settings, false, now), /rgba\(245,246,248,0\.043\)/);
  assert.match(C.css(entry, { ...settings, transparency: 80 }, false, now), /rgba\(245,246,248,0\.008\)/);
  assert.equal(C.css(entry, { ...settings, enabled: false }, false, now), '');
  assert.equal(C.css(entry, { ...settings, transparency: 0 }, false, now), '');
});
test('cache expires and skips different OS schemes and incompatible versions', () => {
  assert.equal(C.css(entry, settings, false, now + C.MAX_AGE), '');
  assert.equal(C.css(entry, settings, true, now), '');
  assert.equal(C.css({ ...entry, version: 999 }, settings, false, now), '');
});
test('replay is guarded by page theme attributes and excluded during original-style reads', () => {
  const css = C.css({ ...entry, html: { ...attrs, class: 'dark', 'data-theme': 'night"\\' } }, settings, false, now);
  assert.match(css, /\[class="dark"\]/);
  assert.match(css, /:has\(>body/);
  assert.ok(css.includes('night\\22 \\5c '));
  assert.match(css, /:not\(\[data-helium-glass-measuring\]\)/);
  // Keep replay active while newly marked elements wait for fresh CSS to arrive.
  assert.doesNotMatch(css, /data-helium-glass-surface/);
});
test('invalid selectors, colors and oversized entries cannot produce cached CSS', () => {
  for (const selector of ['*', 'button', '#a;}body{color:red', 'body,video']) {
    assert.equal(C.css({ ...entry, surfaces: [{ ...entry.surfaces[0], selector }] }, settings, false, now), '');
  }
  assert.equal(C.valid({ ...entry, surfaces: [{ selector: 'body', color: { r: Infinity, g: 0, b: 0, a: 1 } }] }, now), false);
  assert.equal(C.valid({ ...entry, surfaces: Array(C.MAX_SURFACES + 1).fill(entry.surfaces[0]) }, now), false);
});
test('only the newest 64 valid hashed entries are retained', () => {
  const values = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [i.toString(16).padStart(64, '0'), { ...entry, time: now - i }]));
  values['https://raw-url.test/private'] = entry;
  const result = C.prune(values, now);
  assert.equal(Object.keys(result).length, C.MAX_PAGES);
  assert.equal(Object.values(result).at(-1).time, now - 63);
});
