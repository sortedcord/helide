// Shared helpers for end-to-end tests that run Helide against the fake Wayland
// compositor in tests/fake-wayland-compositor, with a temporary profile and the
// raw DevTools protocol. No real input devices or desktop session are used.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const browserPath = process.env.HELIDE_TEST_EXECUTABLE ?? join(root, 'build/src/out/Default/helium');
export const compositorPath = join(root, 'build/fake-wayland-compositor/fake-wayland-compositor');
export const STRIP_WIDTH = 215;  // the vertical tab strip, in pixels of the frame

// ---- fake compositor -------------------------------------------------------
export class Compositor {
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
export const run = (total, count, axis = 'y') =>
  Array.from({ length: count }, () => (axis === 'y' ? [0, total / count] : [total / count, 0]));

// ---- frames ----------------------------------------------------------------
export function readPpm(path) {
  const data = readFileSync(path);
  const header = data.subarray(0, 40).toString('latin1').match(/^P6\n(\d+) (\d+)\n255\n/);
  assert.ok(header, 'PPM header');
  return { width: +header[1], height: +header[2], pixels: data.subarray(header[0].length) };
}

// Pixels in the tab strip that changed since `before`, with their centre of mass.
export function changed(before, after, { x0 = 0, x1 = STRIP_WIDTH, threshold = 24 } = {}) {
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
export async function connectCdp(port) {
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
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      return result.result.value;
    } finally { await send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  };
  // A key press sent to a page; browser shortcuts see it first, as with a
  // real keyboard. `modifiers`: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift.
  const key = async (targetId, keyName, code, keyCode, modifiers = 0) => {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    try {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', {
          type, key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers,
        }, sessionId);
      }
    } finally { await send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  };
  const pages = async () => (await send('Target.getTargets')).targetInfos.filter(t => t.type === 'page');
  return { send, evaluate, key, pages, close: () => ws.close() };
}

// ---- the browser -----------------------------------------------------------
// `browserPrefs` go under helium.browser in the new profile's Preferences; the
// vertical tab layout is the default.
// `prefs` are other top-level entries.
export async function launchBrowser(runtimeDir, socket, { browserPrefs = {}, prefs = {}, vmodule = '' } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'helide-test-profile-'));
  mkdirSync(join(profile, 'Default'));
  writeFileSync(join(profile, 'Default/Preferences'), JSON.stringify({
    ...prefs,
    helium: { browser: { layout: 2, ...browserPrefs } },
  }));
  const child = spawn(browserPath, [
    '--ozone-platform=wayland', '--disable-gpu', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,800',
    '--remote-debugging-port=0', '--enable-logging=stderr',
    ...(vmodule ? [`--vmodule=${vmodule}`] : []),
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

export async function waitFor(condition, message, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await sleep(100);
  }
  assert.fail(`timed out: ${message}`);
}

// ---- scenarios -------------------------------------------------------------
// Runs `body` with a fresh compositor and browser. `logFilter` picks the browser
// log lines to print when DEBUG is set.
export async function session(options, body) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'xdg-helide-test-'));
  const socket = 'wl-helide-test';
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
    await body({ compositor, cdp, browser, runtimeDir });
  } finally {
    cdp?.close();
    if (process.env.DEBUG && options.logFilter) {
      console.log(browser.log().split('\n').filter(line => options.logFilter.test(line)).join('\n'));
    }
    browser.child.kill('SIGTERM');
    await compositor.quit();
    await sleep(300);
    rmSync(browser.profile, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

// Opens tabs "Tab 1" ... "Tab N" after the initial one, in strip order.
export async function openTabs(cdp, count) {
  const html = n => `data:text/html,<title>Tab ${n}</title><body style="height:3000px">Tab ${n}`;
  for (let n = 1; n <= count; n++) {
    await cdp.send('Target.createTarget', { url: html(n) });
    await sleep(120);
  }
  await waitFor(async () => (await cdp.pages()).length === count + 1, 'all tabs to open');
  await sleep(500);
}

// The title of the tab that is showing, and the page scroll offsets.
export async function activeTab(cdp) {
  for (const target of await cdp.pages()) {
    const state = await cdp.evaluate(target.targetId, 'document.visibilityState + "|" + document.title + "|" + scrollY');
    const [visibility, title, scrollY] = state.split('|');
    if (visibility === 'visible') return { title: title || 'about:blank', scrollY: +scrollY, targetId: target.targetId };
  }
  return null;
}
export async function activate(cdp, title) {
  for (const target of await cdp.pages()) {
    if ((await cdp.evaluate(target.targetId, 'document.title')) === title) {
      await cdp.send('Target.activateTarget', { targetId: target.targetId });
      await sleep(400);
      return;
    }
  }
  assert.fail(`no tab titled ${title}`);
}

export function makeTester() {
  const state = { failures: 0 };
  state.test = async (name, fn) => {
    try { await fn(); console.log(`PASS: ${name}`); }
    catch (error) { state.failures++; console.log(`FAIL: ${name}\n  ${String(error.stack ?? error).split('\n').slice(0, 6).join('\n  ')}`); }
  };
  return state;
}

export function ensureBuilt() {
  if (!existsSync(browserPath)) throw new Error(`No browser at ${browserPath}`);
  if (!existsSync(compositorPath)) {
    execFileSync(join(root, 'tests/fake-wayland-compositor/build.sh'), { stdio: 'inherit' });
  }
}
