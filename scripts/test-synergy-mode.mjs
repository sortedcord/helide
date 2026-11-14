#!/usr/bin/env node
// End-to-end test for Synergy mode: the toolbar row moves into the vertical tab
// strip, and with autohide the address bar shows only while the window is not
// focused.
//
// Runs Helide against the fake Wayland compositor in
// tests/fake-wayland-compositor with temporary profiles, checks frames of the
// window and the page's viewport, and sends shortcuts through the DevTools
// protocol. No real input devices or desktop session are involved.
//
//   node scripts/test-synergy-mode.mjs
//
// Needs a built tree (build/src/out/Default/helium), libwayland-server and
// wayland-scanner. HELIDE_TEST_EXECUTABLE overrides the browser.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  activate, activeTab, ensureBuilt, makeTester, openTabs, session as baseSession, waitFor,
} from './lib/fake-wayland-browser.mjs';

const frames = '/tmp/helide-synergy-frame';
const CTRL = 2, SHIFT = 8;

const session = (browserPrefs, body, prefs = {}) => baseSession({
  browserPrefs, prefs, vmodule: 'helium_synergy_controller=1', logFilter: /Synergy|Check failed|FATAL/,
}, body);
const tester = makeTester();
const { test } = tester;

// How much is drawn in a rectangle of a frame: pixels that differ clearly from
// the rectangle's most common colour.
function ink(frame, [x0, y0, x1, y1]) {
  const counts = new Map();
  const at = (x, y) => {
    const i = (y * frame.width + x) * 3;
    return [frame.pixels[i], frame.pixels[i + 1], frame.pixels[i + 2]];
  };
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const key = at(x, y).join(',');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const base = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
  let drawn = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const [r, g, b] = at(x, y);
    if (Math.abs(r - base[0]) + Math.abs(g - base[1]) + Math.abs(b - base[2]) > 60) drawn++;
  }
  return drawn;
}

// The share of a rectangle that has the tab strip's background colour.
function stripShare(frame, [x0, y0, x1, y1]) {
  const at = (x, y) => {
    const i = (y * frame.width + x) * 3;
    return [frame.pixels[i], frame.pixels[i + 1], frame.pixels[i + 2]];
  };
  const strip = at(20, 650);
  let same = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const [r, g, b] = at(x, y);
    if (Math.abs(r - strip[0]) + Math.abs(g - strip[1]) + Math.abs(b - strip[2]) < 8) same++;
  }
  return same / ((x1 - x0) * (y1 - y0));
}
// The address bar has its own background; without it the strip's shows.
const BAR_BACKGROUND = [30, 17, 190, 42];
const addressBarShown = frame => stripShare(frame, BAR_BACKGROUND) < 0.4;

// Where things are in a 1280x800 window with a 200 DIP strip on the left.
const STRIP_BOTTOM = [20, 760, 200, 800];    // the toolbar buttons
const TOOLBAR_ROW = [400, 14, 1100, 44];     // the normal toolbar, over the page
const COLLAPSED_TOP = [16, 14, 58, 44];
const COLLAPSED_BOTTOM = [16, 760, 58, 800];
const COLLAPSED_STRIP_EDGE = [70, 300, 190, 500];  // page when collapsed, strip when expanded

const viewport = async cdp => {
  const tab = await activeTab(cdp);
  return { height: await cdp.evaluate(tab.targetId, 'innerHeight'), tab };
};
// The view that has focus in the browser window, from the controller's log.
const focusedView = browser => {
  const moves = [...browser.log().matchAll(/Synergy: focus \S+ -> (\S+)/g)];
  return moves.length ? moves[moves.length - 1][1] : 'unknown';
};

// Sets a pref through chrome://settings, as the settings page does.
async function setPref(cdp, key, value) {
  let settings = (await cdp.pages()).find(t => t.url.startsWith('chrome://settings'));
  if (!settings) {
    await cdp.send('Target.createTarget', { url: 'chrome://settings/appearance', background: true });
    settings = await waitFor(async () => (await cdp.pages()).find(t => t.url.startsWith('chrome://settings')), 'settings to open');
    await sleep(1500);
  }
  const ok = await cdp.evaluate(settings.targetId,
      `new Promise(r => chrome.settingsPrivate.setPref(${JSON.stringify(key)}, ${JSON.stringify(value)}, '', r))`);
  assert.ok(ok, `set ${key}`);
  await sleep(1000);
}

ensureBuilt();

let classicHeight = 0;
await session({}, async ({ compositor, cdp }) => {
  await openTabs(cdp, 2);
  classicHeight = (await viewport(cdp)).height;
});

await session({ synergy_mode: true }, async ({ compositor, cdp, browser }) => {
  await openTabs(cdp, 2);
  await sleep(800);

  await test('the page takes the height of the toolbar row', async () => {
    const { height } = await viewport(cdp);
    assert.ok(height >= classicHeight + 25, `viewport ${height}, ${classicHeight} with a toolbar`);
    const frame = await compositor.frame(`${frames}-on.ppm`);
    assert.ok(ink(frame, TOOLBAR_ROW) < 40, 'no toolbar over the page');
  });

  await test('the address bar is at the top of the strip, the buttons at its bottom', async () => {
    const frame = await compositor.frame(`${frames}-on.ppm`);
    assert.ok(addressBarShown(frame), `strip background share ${stripShare(frame, BAR_BACKGROUND)}`);
    assert.ok(ink(frame, STRIP_BOTTOM) > 80, `toolbar button ink ${ink(frame, STRIP_BOTTOM)}`);
  });

  await test('Ctrl+L focuses the address bar', async () => {
    await activate(cdp, 'Tab 1');
    assert.equal(focusedView(browser), 'ContentsWebView', 'a tab switch focuses the page');
    const { tab } = await viewport(cdp);
    await cdp.key(tab.targetId, 'l', 'KeyL', 76, CTRL);
    await sleep(500);
    assert.equal(focusedView(browser), 'OmniboxViewViews');
  });

  await test('turning it off and on again moves the toolbar back and forth', async () => {
    await setPref(cdp, 'helium.browser.synergy_mode', false);
    let frame = await compositor.frame(`${frames}-off-again.ppm`);
    assert.ok(ink(frame, TOOLBAR_ROW) > 40, 'the toolbar row is back');
    await setPref(cdp, 'helium.browser.synergy_mode', true);
    frame = await compositor.frame(`${frames}-on-again.ppm`);
    assert.ok(ink(frame, TOOLBAR_ROW) < 40, 'and gone again');
    assert.ok(addressBarShown(frame), 'the address bar is in the strip again');
  });

  await test('switching to another layout and back keeps working', async () => {
    await setPref(cdp, 'helium.browser.layout', 0);
    let frame = await compositor.frame(`${frames}-classic.ppm`);
    assert.ok(ink(frame, TOOLBAR_ROW) > 40, 'the classic layout has its toolbar');
    await setPref(cdp, 'helium.browser.layout', 2);
    frame = await compositor.frame(`${frames}-vertical.ppm`);
    assert.ok(ink(frame, TOOLBAR_ROW) < 40, 'Synergy mode is back with vertical tabs');
    assert.ok(addressBarShown(frame), 'with the address bar in the strip');
  });

  await test('Zen mode turns it off', async () => {
    await setPref(cdp, 'helium.browser.zen_mode', true);
    await setPref(cdp, 'helium.browser.zen_mode', false);
    const frame = await compositor.frame(`${frames}-after-zen.ppm`);
    assert.ok(addressBarShown(frame), 'Synergy mode is back after Zen mode');
  });

  await test('the outline around the extension icons is around them', async () => {
    await compositor.cmd('motion 35 785');  // hovering a pinned extension shows it
    await sleep(1000);
    const frame = await compositor.frame(`${frames}-outline.ppm`);
    await compositor.cmd('motion 700 400');
    // Rows where the outline's top or bottom edge runs across the icons.
    const edges = [];
    for (let y = 740; y < 800; y++) {
      let light = 0;
      for (let x = 20; x < 82; x++) {
        const i = (y * frame.width + x) * 3;
        if (frame.pixels[i] + frame.pixels[i + 1] + frame.pixels[i + 2] > 200) light++;
      }
      if (light > 40) edges.push(y);
    }
    assert.equal(edges.length, 2, `a top and a bottom edge, got rows ${edges}`);
    assert.ok(edges[1] - edges[0] > 20, 'around the icons, not through them');
  });

  await test('bubbles from the bottom buttons open upwards, inside the window', async () => {
    // The extensions button, then the pinned extension (uBlock Origin).
    for (const x of [66, 35]) {
      await compositor.cmd(`click ${x} 785`);
      await sleep(1800);
      const reply = await compositor.cmd('popups');
      const bubbles = [...reply.matchAll(/subsurface at=(-?\d+),(-?\d+) size=(\d+)x(\d+)/g)]
          .map(m => m.slice(1).map(Number)).filter(([, , w, h]) => w > 100 && h > 100);
      assert.ok(bubbles.length, `a bubble opened: ${reply}`);
      for (const [bx, by, w, h] of bubbles) {
        assert.ok(bx >= 0 && by >= 0 && bx + w <= 1280 && by + h <= 800, `inside the window: ${bx},${by} ${w}x${h}`);
        assert.ok(by + h <= 790, `above the button: ${bx},${by} ${w}x${h}`);
      }
      await compositor.cmd('click 700 400');
      await sleep(800);
    }
  });

  await test('the app menu lets the compositor flip it upwards', async () => {
    await compositor.cmd('popups');
    await compositor.cmd('click 126 785');
    await sleep(1500);
    const reply = await compositor.cmd('popups');
    const constraint = +(reply.match(/popup .*?constraint=(\d+)/)?.[1] ?? -1);
    assert.ok(constraint >= 0, `a menu opened: ${reply}`);
    assert.ok(constraint & 8, 'flip_y is allowed');
    await compositor.cmd('click 700 400');
    await sleep(500);
  });

  await test('closing the window with it on is clean', async () => {
    const { tab } = await viewport(cdp);
    for (const target of await cdp.pages()) {
      if (target.targetId !== tab.targetId) await cdp.send('Target.closeTarget', { targetId: target.targetId });
    }
    await cdp.send('Browser.close').catch(() => {});
    await sleep(1500);
  });
});

await session({ synergy_mode: true, synergy_autohide_address_bar: true }, async ({ compositor, cdp, browser }) => {
  await openTabs(cdp, 2);
  await sleep(800);
  const { tab, height } = await viewport(cdp);

  await test('autohide: no address bar while the window is focused', async () => {
    const frame = await compositor.frame(`${frames}-autohide.ppm`);
    assert.ok(!addressBarShown(frame), `strip background share ${stripShare(frame, BAR_BACKGROUND)}`);
    assert.ok(ink(frame, STRIP_BOTTOM) > 80, 'the toolbar buttons stay');
  });

  await test('autohide: the address bar shows while another window is focused', async () => {
    await compositor.cmd('activate 0');
    await sleep(700);
    let frame = await compositor.frame(`${frames}-inactive.ppm`);
    assert.ok(addressBarShown(frame), `strip background share ${stripShare(frame, BAR_BACKGROUND)}`);
    assert.equal((await viewport(cdp)).height, height, 'the page does not move');
    await compositor.cmd('activate 1');
    await sleep(150);
    frame = await compositor.frame(`${frames}-just-active.ppm`);
    assert.ok(addressBarShown(frame), 'it stays a moment after activation, for the activating click');
    await sleep(900);
    frame = await compositor.frame(`${frames}-active-again.ppm`);
    assert.ok(!addressBarShown(frame), 'then hides');
  });

  await test('autohide: it slides in and out instead of popping', async () => {
    const sample = async name => {
      const shares = [];
      for (let n = 0; n < 16; n++) {
        shares.push(stripShare(await compositor.frame(`${frames}-${name}-${n}.ppm`), BAR_BACKGROUND));
        await sleep(20);
      }
      return shares;
    };
    await compositor.cmd('activate 0');
    const showing = await sample('show');
    await compositor.cmd('activate 1');
    await sleep(300);  // the delay after activation
    const hiding = await sample('hide');
    // The strip's background share is about 0.84 hidden and 0 shown.
    const partial = values => values.filter(v => v > 0.05 && v < 0.8).length;
    assert.ok(partial(showing) >= 2, `in-between frames while showing: ${showing.map(v => v.toFixed(2))}`);
    assert.ok(partial(hiding) >= 2, `in-between frames while hiding: ${hiding.map(v => v.toFixed(2))}`);
    assert.ok(showing.at(-1) < 0.4 && hiding.at(-1) >= 0.4, 'ends shown, then hidden');
  });

  await test('autohide: Ctrl+L does nothing', async () => {
    await cdp.key(tab.targetId, 'l', 'KeyL', 76, CTRL);
    await sleep(500);
    const frame = await compositor.frame(`${frames}-ctrl-l.ppm`);
    assert.ok(!addressBarShown(frame), 'still hidden');
    assert.notEqual(focusedView(browser), 'OmniboxViewViews', 'the address bar has no focus');
  });

  await test('autohide: Ctrl+Shift+L shows and focuses it, and again hides it', async () => {
    await cdp.key(tab.targetId, 'L', 'KeyL', 76, CTRL | SHIFT);
    await sleep(500);
    let frame = await compositor.frame(`${frames}-revealed.ppm`);
    assert.ok(addressBarShown(frame), 'shown');
    assert.equal(focusedView(browser), 'OmniboxViewViews', 'and focused');
    await cdp.key(tab.targetId, 'L', 'KeyL', 76, CTRL | SHIFT);
    await sleep(500);
    frame = await compositor.frame(`${frames}-hidden-again.ppm`);
    assert.ok(!addressBarShown(frame), 'hidden again');
    assert.equal(focusedView(browser), 'ContentsWebView', 'with focus back on the page');
  });
});

await session({ synergy_mode: true }, async ({ compositor, cdp, browser }) => {
  await openTabs(cdp, 2);
  await compositor.cmd('motion 900 400');  // away from the strip
  await sleep(1200);

  await test('collapsed: an icon for the address bar and just the app menu', async () => {
    const frame = await compositor.frame(`${frames}-collapsed.ppm`);
    const top = ink(frame, COLLAPSED_TOP), bottom = ink(frame, COLLAPSED_BOTTOM);
    assert.ok(top > 15 && top < 150, `address bar icon ink ${top}`);
    assert.ok(bottom > 8 && bottom < 120, `app menu ink ${bottom}`);
  });

  await test('collapsed: Ctrl+L expands the strip around the address bar', async () => {
    const { tab } = await viewport(cdp);
    const before = stripShare(await compositor.frame(`${frames}-collapsed.ppm`), COLLAPSED_STRIP_EDGE);
    assert.ok(before < 0.1, 'the page is there while collapsed');
    await cdp.key(tab.targetId, 'l', 'KeyL', 76, CTRL);
    await sleep(1200);
    const frame = await compositor.frame(`${frames}-collapsed-focused.ppm`);
    assert.ok(addressBarShown(frame), 'the address bar shows');
    assert.ok(stripShare(frame, COLLAPSED_STRIP_EDGE) > 0.9, 'the strip expanded over the page');
    assert.equal(focusedView(browser), 'OmniboxViewViews', 'and it has focus');
  });
}, { vertical_tabs: { collapsed_state: true } });

if (tester.failures) { console.log(`${tester.failures} test(s) failed`); process.exit(1); }
console.log('All Synergy mode tests passed.');
