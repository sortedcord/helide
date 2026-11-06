const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../palette.js');
require('../shared.js');
const white = { r: 255, g: 255, b: 255, a: 1 };
const dark = { r: 24, g: 26, b: 31, a: 1 };
const settings = { transparency: 65, protectContrast: true };
const theme = P.inferTheme([white, white, dark], true);
test('actual page palette wins over the OS theme', () => {
  assert.equal(theme.mode, 'light');
  assert.equal(P.inferTheme([dark, dark, white], false).mode, 'dark');
});
test('a page canvas is clearer than a text-bearing card', () => {
  const base = P.surface(white, dark, { root: true }, theme, settings);
  const card = P.surface(white, dark, {}, theme, settings);
  assert.ok(base.a < 0.1);
  assert.ok(card.a > base.a && card.a < 1);
  assert.equal(card.r, 255);
});
test('strong accent colors and protected surfaces are kept intact', () => {
  assert.equal(P.surface({ r: 15, g: 90, b: 245, a: 1 }, white, {}, theme, settings), null);
  assert.equal(P.surface(white, dark, { protected: true }, theme, settings), null);
});
test('contrast protection increases card opacity', () => {
  const safe = P.surface(dark, white, {}, P.inferTheme([dark], false), settings);
  const airy = P.surface(dark, white, {}, P.inferTheme([dark], false), { ...settings, protectContrast: false });
  assert.ok(safe.a > airy.a);
});
test('transparent pixels are not replaced with a tint', () => {
  assert.equal(P.surface({ ...white, a: 0 }, dark, {}, theme, settings), null);
});
test('existing alpha is never made more opaque than its original value', () => {
  assert.ok(P.surface({ ...white, a: 0.4 }, dark, {}, theme, settings).a <= 0.4);
});
test('image backgrounds cannot be rewritten as gradients', () => {
  assert.equal(P.gradient('url("https://example.test/image.png")', () => white), null);
  assert.equal(P.gradient('image-set(url("x") 1x)', () => white), null);
});
test('gradient stops retain color and get explicit alpha', () => {
  const gradient = P.gradient('linear-gradient(rgb(255, 255, 255), rgb(24, 26, 31))', value => value.includes('255') ? white : dark);
  assert.equal(gradient.recolor(0.4), 'linear-gradient(rgba(255, 255, 255, 0.4), rgba(24, 26, 31, 0.4))');
});
test('site opt-out and global disable take precedence', () => {
  const S = global.HeliumGlassSettings;
  assert.equal(S.isEnabled(S.normalize({ sites: { 'example.test': false } }), 'example.test'), false);
  assert.equal(S.isEnabled(S.normalize({ enabled: false }), 'other.test'), false);
  assert.equal(S.isEnabled(S.normalize({ transparency: 0 }), 'other.test'), false);
  assert.equal(S.siteKey('file:///tmp/page.html'), 'file://');
  assert.equal(S.siteKey('chrome://flags'), null);
  assert.equal(S.normalize(null).transparency, 65);
});
