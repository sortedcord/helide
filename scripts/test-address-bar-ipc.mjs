#!/usr/bin/env node
// End-to-end test for the address bar socket that comes with Synergy mode
// (docs/address-bar-ipc.md).
//
// Runs Helide against the fake Wayland compositor in
// tests/fake-wayland-compositor with temporary profiles and a temporary
// XDG_RUNTIME_DIR, and talks to $XDG_RUNTIME_DIR/helide-address-bar.sock.
//
//   node scripts/test-address-bar-ipc.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

import { ensureBuilt, makeTester, openTabs, session, waitFor } from './lib/fake-wayland-browser.mjs';

const tester = makeTester();
const { test } = tester;

// A client: requests with ids, and every message kept for inspection.
async function client(path) {
  const socket = connect(path);
  await new Promise((ok, fail) => { socket.once('connect', ok); socket.once('error', fail); });
  const messages = [];
  createInterface({ input: socket }).on('line', line => messages.push(JSON.parse(line)));
  let nextId = 0;
  const request = async (cmd, fields = {}) => {
    const id = ++nextId;
    socket.write(JSON.stringify({ id, cmd, ...fields }) + '\n');
    return waitFor(() => messages.find(m => m.id === id && 'ok' in m), `a reply to ${cmd}`);
  };
  const raw = text => socket.write(text + '\n');
  const events = (event, filter = () => true) => messages.filter(m => m.event === event && filter(m));
  return { socket, messages, request, raw, events, close: () => socket.destroy() };
}

ensureBuilt();

await session({ browserPrefs: {} }, async ({ runtimeDir }) => {
  await test('there is no socket without Synergy mode', async () => {
    await sleep(1000);
    assert.equal(existsSync(join(runtimeDir, 'helide-address-bar.sock')), false);
  });
});

await session({ browserPrefs: { synergy_mode: true }, vmodule: 'helium_address_bar_ipc=1', logFilter: /Address bar socket|Check failed|FATAL/ },
    async ({ cdp, runtimeDir }) => {
  const path = join(runtimeDir, 'helide-address-bar.sock');
  await waitFor(() => existsSync(path), 'the socket');
  await openTabs(cdp, 1);
  const c = await client(path);

  let windowId;
  await test('hello and list', async () => {
    assert.equal((await c.request('hello')).version, 1);
    const { windows } = await c.request('list');
    assert.equal(windows.length, 1);
    windowId = windows[0].window;
    assert.equal(windows[0].title, 'Tab 1');
    assert.match(windows[0].url, /^data:text\/html/);
    assert.equal(windows[0].focused, true);
    assert.equal(windows[0].loading, false);
    assert.equal(windows[0].progress, 1);
  });

  await test('subscribing sends the state now and on every change', async () => {
    assert.equal((await c.request('subscribe')).ok, true);
    await waitFor(() => c.events('state').length >= 1, 'the current state');
    const before = c.messages.length;
    const reply = await c.request('navigate', { text: 'data:text/html,<title>Typed</title>typed' });
    assert.equal(reply.ok, true);
    await waitFor(() => c.events('state', m => m.title === 'Typed' && !m.loading).length, 'the new page');
    const states = c.messages.slice(before).filter(m => m.event === 'state');
    assert.ok(states.some(m => m.loading), 'a loading state');
    assert.ok(states.every(m => m.progress >= 0 && m.progress <= 1), 'progress is a fraction');
    assert.ok(states.every(m => m.window === windowId));
  });

  await test('progress is the exact fraction while a page loads', async () => {
    // A page whose images arrive one by one.
    const server = createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html');
        res.end('<title>Slow</title>' + [1, 2, 3, 4].map(n => `<img src="/img${n}">`).join(''));
        return;
      }
      setTimeout(() => res.end(), 400 * +req.url.slice(4));
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    try {
      const before = c.messages.length;
      await c.request('navigate', { url: `http://127.0.0.1:${server.address().port}/` });
      await waitFor(() => c.events('state').at(-1)?.title === 'Slow' && !c.events('state').at(-1).loading,
          'the slow page to finish', { timeout: 20000 });
      const fractions = c.messages.slice(before).filter(m => m.event === 'state' && m.loading).map(m => m.progress);
      const between = new Set(fractions.filter(p => p > 0 && p < 1).map(p => p.toFixed(3)));
      assert.ok(between.size >= 2, `several partial fractions: ${fractions.map(p => p.toFixed(3))}`);
      for (let i = 1; i < fractions.length; i++) assert.ok(fractions[i] >= fractions[i - 1], `progress only goes up: ${fractions.map(p => p.toFixed(3))}`);
    } finally { server.close(); }
  });

  await test('back, forward, reload and stop', async () => {
    assert.equal((await c.request('back')).ok, true);
    await waitFor(() => c.events('state').at(-1)?.title === 'Typed', 'back to Typed');
    assert.equal((await c.request('forward')).ok, true);
    await waitFor(() => c.events('state').at(-1)?.title === 'Slow', 'forward to Slow');
    const before = c.events('state').length;
    assert.equal((await c.request('reload', { window: windowId })).ok, true);
    await waitFor(() => c.events('state').slice(before).some(m => m.loading), 'a reload');
    await c.request('stop');  // ok or "not available now" once it finished
  });

  await test('url is opened as given; javascript: is refused', async () => {
    assert.equal((await c.request('navigate', { url: 'data:text/html,<title>Exact</title>' })).ok, true);
    await waitFor(() => c.events('state').at(-1)?.title === 'Exact', 'the exact URL');
    const refused = await c.request('navigate', { url: 'javascript:alert(1)' });
    assert.equal(refused.ok, false);
  });

  await test('complete answers with suggestions for any text', async () => {
    const reply = await c.request('complete', { text: 'example' });
    assert.equal(reply.ok, true);
    const result = await waitFor(() => c.messages.find(m => m.id === reply.id && m.event === 'suggestions' && m.done), 'the final suggestions');
    assert.equal(result.source, 'query');
    assert.equal(result.input, 'example');
    assert.ok(result.suggestions.length >= 1, 'at least what was typed');
    for (const s of result.suggestions) {
      assert.equal(typeof s.contents, 'string');
      assert.equal(typeof s.url, 'string');
      assert.equal(typeof s.type, 'string');
    }
  });

  await test('bad requests get errors, not a dropped connection', async () => {
    c.raw('this is not json');
    await waitFor(() => c.messages.some(m => m.ok === false && m.error === 'not a JSON object'), 'a parse error');
    assert.equal((await c.request('fly')).error, 'unknown cmd');
    assert.equal((await c.request('reload', { window: 123456789 })).error, 'no such window');
    assert.equal((await c.request('hello')).ok, true, 'still connected');
  });

  await test('turning Synergy mode off closes the socket', async () => {
    const settings = await (async () => {
      await cdp.send('Target.createTarget', { url: 'chrome://settings/appearance', background: true });
      return waitFor(async () => (await cdp.pages()).find(t => t.url.startsWith('chrome://settings')), 'settings');
    })();
    await sleep(1500);
    await cdp.evaluate(settings.targetId,
        `new Promise(r => chrome.settingsPrivate.setPref('helium.browser.synergy_mode', false, '', r))`);
    await waitFor(() => c.events('closed', m => m.window === windowId).length, 'a closed event');
    await waitFor(() => !existsSync(path), 'the socket to go away');
  });
  c.close();
});

if (tester.failures) { console.log(`${tester.failures} test(s) failed`); process.exit(1); }
console.log('All address bar socket tests passed.');
