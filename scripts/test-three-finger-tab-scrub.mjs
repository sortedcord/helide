#!/usr/bin/env node
// End-to-end test for three-finger tab scrubbing.
//
// Starts a fake Wayland compositor (tests/fake-wayland-compositor) that sends
// real zwp_pointer_gesture_swipe_v1 events, launches Helide against it with a
// temporary profile, and checks what a swipe does. No real input devices or
// desktop session are involved.
//
//   node scripts/test-three-finger-tab-scrub.mjs
//
// Needs a built tree (build/src/out/Default/helium), libwayland-server and
// wayland-scanner. HELIDE_TEST_EXECUTABLE overrides the browser.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  activate, activeTab, changed, ensureBuilt, makeTester, openTabs, run, session as baseSession,
} from './lib/fake-wayland-browser.mjs';

// The scrub settings for each session, and its log lines with DEBUG=1.
const session = ({ scrubEnabled = true, scrubInvert = false } = {}, body) => baseSession({
  browserPrefs: { three_finger_tab_scrub: scrubEnabled, three_finger_tab_scrub_invert: scrubInvert },
  vmodule: 'helium_tab_scrubber=2',
  logFilter: /Tab scrub/,
}, body);
const tester = makeTester();
const { test } = tester;

ensureBuilt();

await session({}, async ({ compositor, cdp }) => {
  await openTabs(cdp, 9);  // strip order: about:blank, Tab 1 ... Tab 9
  const frames = '/tmp/helide-scrub-frame';

  await test('a vertical three-finger swipe moves through tabs and commits on lift', async () => {
    await activate(cdp, 'Tab 3');
    const before = await compositor.frame(`${frames}-before.ppm`);
    // 80 DIPs at 37 DIPs per tab is 2.2 tabs: it lands on Tab 5.
    await compositor.swipe(3, run(80, 20));
    await sleep(300);
    assert.equal((await activeTab(cdp)).title, 'Tab 3', 'the page does not change while the fingers are down');
    const during = await compositor.frame(`${frames}-during.ppm`);
    const glow = changed(before, during);
    assert.ok(glow.count > 400, `the glow should be visible in the tab strip (changed pixels: ${glow.count})`);
    await compositor.end();
    await sleep(600);
    assert.equal((await activeTab(cdp)).title, 'Tab 5');
  });

  await test('the glow moves continuously, not in steps', async () => {
    await activate(cdp, 'Tab 2');
    const before = await compositor.frame(`${frames}-base.ppm`);
    const centres = [];
    await compositor.cmd('swipe_begin 3');
    // 14 DIPs locks the axis; after that every few DIPs is a visible change.
    for (const target of [20, 34, 48, 62]) {
      const have = centres.length ? [20, 34, 48, 62][centres.length - 1] : 0;
      const step = target - have;
      for (let i = 0; i < 4; i++) { await compositor.cmd(`swipe_update 0 ${step / 4}`); await sleep(16); }
      await sleep(200);
      centres.push(changed(before, await compositor.frame(`${frames}-c${target}.ppm`)).centreY);
    }
    await compositor.end(true);  // cancelled: stay put
    await sleep(500);
    for (let i = 1; i < centres.length; i++) {
      assert.ok(centres[i] > centres[i - 1] + 2, `glow centre should keep moving down: ${centres.map(c => c.toFixed(1))}`);
    }
    // Steps between tabs would put the glow at a few fixed rows (32 DIPs apart).
    const gaps = centres.slice(1).map((c, i) => c - centres[i]);
    assert.ok(new Set(gaps.map(g => Math.round(g))).size >= 1 && gaps.every(g => g < 28),
        `movement should be smooth, gaps: ${gaps.map(g => g.toFixed(1))}`);
    assert.equal((await activeTab(cdp)).title, 'Tab 2', 'a cancelled swipe changes nothing');
  });

  await test('swiping up moves back and stops at the first tab', async () => {
    await activate(cdp, 'Tab 2');
    await compositor.swipe(3, run(-120, 24));
    await compositor.end();
    await sleep(600);
    assert.equal((await activeTab(cdp)).title, 'about:blank');
    await compositor.swipe(3, run(-300, 30));
    await compositor.end();
    await sleep(500);
    assert.equal((await activeTab(cdp)).title, 'about:blank', 'it does not wrap around');
  });

  await test('swiping down stops at the last tab', async () => {
    await activate(cdp, 'Tab 8');
    await compositor.swipe(3, run(400, 40));
    await compositor.end();
    await sleep(600);
    assert.equal((await activeTab(cdp)).title, 'Tab 9');
  });

  await test('going out and coming back lands on the same tab', async () => {
    await activate(cdp, 'Tab 4');
    await compositor.swipe(3, [...run(90, 18), ...run(-90, 18)]);
    await compositor.end();
    await sleep(500);
    assert.equal((await activeTab(cdp)).title, 'Tab 4');
  });

  await test('a little finger movement does nothing', async () => {
    await activate(cdp, 'Tab 4');
    const before = await compositor.frame(`${frames}-rest.ppm`);
    await compositor.swipe(3, run(8, 4));
    await sleep(250);
    const during = await compositor.frame(`${frames}-rest2.ppm`);
    assert.ok(changed(before, during).count < 80, 'no glow for a resting hand');
    await compositor.end();
    await sleep(300);
    assert.equal((await activeTab(cdp)).title, 'Tab 4');
  });

  await test('a three-finger swipe never scrolls the page', async () => {
    await activate(cdp, 'Tab 4');
    await compositor.swipe(3, run(30, 10));
    await compositor.end(true);
    await sleep(300);
    await compositor.swipe(3, run(300, 10, 'x'));
    await compositor.end();
    await sleep(500);
    const tab = await activeTab(cdp);
    assert.equal(tab.title, 'Tab 4', 'a horizontal swipe with no split view does nothing');
    assert.equal(tab.scrollY, 0, 'the page must not scroll');
  });

  await test('two-finger swipes are left to the page', async () => {
    await activate(cdp, 'Tab 4');
    await compositor.swipe(2, run(60, 6));
    await compositor.end();
    await sleep(400);
    assert.equal((await activeTab(cdp)).title, 'Tab 4');
  });
});

await session({ scrubEnabled: false }, async ({ compositor, cdp }) => {
  await openTabs(cdp, 5);
  await test('with the setting off a swipe does nothing, and still does not scroll', async () => {
    await activate(cdp, 'Tab 2');
    await compositor.swipe(3, run(150, 20));
    await compositor.end();
    await sleep(500);
    const tab = await activeTab(cdp);
    assert.equal(tab.title, 'Tab 2');
    assert.equal(tab.scrollY, 0);
  });
});

await session({ scrubInvert: true }, async ({ compositor, cdp }) => {
  await openTabs(cdp, 9);
  await test('inverted: swiping down moves back, swiping up moves forward', async () => {
    await activate(cdp, 'Tab 5');
    // 80 DIPs at 37 DIPs per tab is 2.2 tabs.
    await compositor.swipe(3, run(80, 20));
    await compositor.end();
    await sleep(600);
    assert.equal((await activeTab(cdp)).title, 'Tab 3');
    await compositor.swipe(3, run(-80, 20));
    await compositor.end();
    await sleep(600);
    assert.equal((await activeTab(cdp)).title, 'Tab 5');
  });
});

if (tester.failures) { console.log(`${tester.failures} test(s) failed`); process.exit(1); }
console.log('All three-finger tab scrub tests passed.');
