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
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const browserPath = process.env.HELIDE_TEST_EXECUTABLE ?? join(root, 'build/src/out/Default/helium');
const compositorPath = join(root, 'build/fake-wayland-compositor/fake-wayland-compositor');
const STRIP_WIDTH = 215;  // the vertical tab strip, in pixels of the frame

// ---- fake compositor -------------------------------------------------------
class Compositor {
  constructor(runtimeDir, socket) {
    this.process = spawn(compositorPath, [socket], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.lines = [];
    this.waiters = [];
    createInterface({ input: this.process.stdout }).on('line', line => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line); else this.lines.push(line);
    });
  }
  next() {
    const line = this.lines.shift();
    return line !== undefined ? Promise.resolve(line) : new Promise(resolve => this.waiters.push(resolve));
  }
  async cmd(text) {
    this.process.stdin.write(text + '\n');
    const reply = await this.next();
    assert.ok(reply.startsWith('ok'), `compositor: ${text} -> ${reply}`);
    return reply;
  }
  async ready() { assert.match(await this.next(), /^ready/); }
  async swipe(fingers, frames, dx, dy, { cancel = false, hold = 0 } = {}) {
    await this.cmd(`swipe_begin ${fingers}`);
    for (const [fx, fy] of frames ?? []) { await this.cmd(`swipe_update ${fx} ${fy}`); await sleep(16); }
    if (hold) await sleep(hold);
    return this;
  }
  async end(cancelled = false) { await this.cmd(`swipe_end ${cancelled ? 1 : 0}`); }
  async frame(path) { await this.cmd(`dump ${path}`); return readPpm(path); }
  async quit() { try { await this.cmd('quit'); } catch { this.process.kill(); } }
}

// A straight run of equal frames: `total` DIPs along one axis in `count` frames.
const run = (total, count, axis = 'y') =>
  Array.from({ length: count }, () => (axis === 'y' ? [0, total / count] : [total / count, 0]));

// ---- frames ----------------------------------------------------------------
function readPpm(path) {
  const data = readFileSync(path);
  const header = data.subarray(0, 40).toString('latin1').match(/^P6\n(\d+) (\d+)\n255\n/);
  assert.ok(header, 'PPM header');
  return { width: +header[1], height: +header[2], pixels: data.subarray(header[0].length) };
}

// Pixels in the tab strip that changed since `before`, with their centre of mass.
function changed(before, after, { x0 = 0, x1 = STRIP_WIDTH, threshold = 24 } = {}) {
  let count = 0, sumY = 0;
  for (let y = 0; y < after.height; y++) {
    for (let x = x0; x < Math.min(x1, after.width); x++) {
      const i = (y * after.width + x) * 3;
      const delta = Math.abs(after.pixels[i] - before.pixels[i]) +
          Math.abs(after.pixels[i + 1] - before.pixels[i + 1]) +
          Math.abs(after.pixels[i + 2] - before.pixels[i + 2]);
      if (delta > threshold) { count++; sumY += y; }
    }
  }
  return { count, centreY: count ? sumY / count : NaN };
}

// ---- raw DevTools protocol (no focus or visibility emulation) ---------------
async function connectCdp(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = message => {
    const data = JSON.parse(message.data);
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    data.error ? entry.fail(new Error(JSON.stringify(data.error))) : entry.ok(data.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const id = ++nextId;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const evaluate = async (targetId, expression) => {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    try {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      return result.result.value;
    } finally { await send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  };
  const pages = async () => (await send('Target.getTargets')).targetInfos.filter(t => t.type === 'page');
  return { send, evaluate, pages, close: () => ws.close() };
}

// ---- the browser -----------------------------------------------------------
async function launchBrowser(runtimeDir, socket, { scrubEnabled = true } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'helide-scrub-profile-'));
  mkdirSync(join(profile, 'Default'));
  // The vertical tab layout, where a vertical swipe follows the tab list.
  writeFileSync(join(profile, 'Default/Preferences'), JSON.stringify({
    helium: { browser: { layout: 2, three_finger_tab_scrub: scrubEnabled } },
  }));
  const child = spawn(browserPath, [
    '--ozone-platform=wayland', '--disable-gpu', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,800',
    '--remote-debugging-port=0', '--enable-logging=stderr', '--vmodule=helium_tab_scrubber=2',
    'about:blank',
  ], { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir, WAYLAND_DISPLAY: socket }, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', data => { log += data; });
  let port = 0;
  for (let i = 0; i < 200 && !port; i++) {
    await sleep(100);
    try { port = +readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {}
  }
  assert.ok(port, `browser did not start:\n${log.slice(-2000)}`);
  return { child, profile, port, log: () => log };
}

async function waitFor(condition, message, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await sleep(100);
  }
  assert.fail(`timed out: ${message}`);
}

// ---- scenarios -------------------------------------------------------------
async function session(options, body) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'xdg-scrub-'));
  const socket = 'wl-scrub-test';
  const compositor = new Compositor(runtimeDir, socket);
  await compositor.ready();
  const browser = await launchBrowser(runtimeDir, socket, options);
  let cdp;
  try {
    const window = await waitFor(async () => {
      const reply = await compositor.cmd('size');
      return /commits=([1-9]\d+) toplevel=1 swipe=1 pointer=1/.test(reply) ? reply : null;
    }, 'the browser window to appear with a swipe gesture object');
    if (!session.logged) {
      session.logged = true;
      console.log(`window: ${window.match(/app_id=(.*)$/)?.[1] || '(none)'} is the Wayland app-id niri will see`);
    }
    cdp = await connectCdp(browser.port);
    await compositor.cmd('enter 640 400');
    await body({ compositor, cdp, browser });
  } finally {
    cdp?.close();
    if (process.env.SCRUB_DEBUG) {
      console.log(browser.log().split('\n').filter(line => /Tab scrub/.test(line)).join('\n'));
    }
    browser.child.kill('SIGTERM');
    await compositor.quit();
    await sleep(300);
    rmSync(browser.profile, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

// Opens tabs "Tab 1" ... "Tab N" after the initial one, in strip order.
async function openTabs(cdp, count) {
  const html = n => `data:text/html,<title>Tab ${n}</title><body style="height:3000px">Tab ${n}`;
  for (let n = 1; n <= count; n++) {
    await cdp.send('Target.createTarget', { url: html(n) });
    await sleep(120);
  }
  await waitFor(async () => (await cdp.pages()).length === count + 1, 'all tabs to open');
  await sleep(500);
}

// The title of the tab that is showing, and the page scroll offsets.
async function activeTab(cdp) {
  for (const target of await cdp.pages()) {
    const state = await cdp.evaluate(target.targetId, 'document.visibilityState + "|" + document.title + "|" + scrollY');
    const [visibility, title, scrollY] = state.split('|');
    if (visibility === 'visible') return { title: title || 'about:blank', scrollY: +scrollY, targetId: target.targetId };
  }
  return null;
}
async function activate(cdp, title) {
  for (const target of await cdp.pages()) {
    if ((await cdp.evaluate(target.targetId, 'document.title')) === title) {
      await cdp.send('Target.activateTarget', { targetId: target.targetId });
      await sleep(400);
      return;
    }
  }
  assert.fail(`no tab titled ${title}`);
}

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); }
  catch (error) { failures++; console.log(`FAIL: ${name}\n  ${String(error.stack ?? error).split('\n').slice(0, 6).join('\n  ')}`); }
}

if (!existsSync(browserPath)) throw new Error(`No browser at ${browserPath}`);
if (!existsSync(compositorPath)) {
  execFileSync(join(root, 'tests/fake-wayland-compositor/build.sh'), { stdio: 'inherit' });
}

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

if (failures) { console.log(`${failures} test(s) failed`); process.exit(1); }
console.log('All three-finger tab scrub tests passed.');
