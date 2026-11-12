import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { validateEndpoint } from './browser.js';

async function clientFor(endpoint: string, artifacts?: string) {
  const client = new Client({ name: 'helium-mcp-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ['dist/index.js'], env: { ...process.env as Record<string, string>, HELIUM_CDP_URL: endpoint,
      ...(artifacts ? { HELIUM_MCP_ARTIFACTS: artifacts } : {}) } }));
  return client;
}

function decoded(result: Awaited<ReturnType<Client['callTool']>>): any {
  const content = result.content as { type: string; text?: string }[];
  const text = content.find(c => c.type === 'text')?.text ?? '';
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

test('only loopback HTTP origins are accepted', () => {
  assert.equal(validateEndpoint('http://localhost:9222'), 'http://localhost:9222');
  assert.equal(validateEndpoint('http://[::1]:9222'), 'http://[::1]:9222');
  for (const endpoint of ['https://example.com', 'file:///tmp/browser', 'http://127.0.0.1/x',
    'http://user:pass@localhost:9222', 'http://localhost:9222/?x=1']) {
    assert.throws(() => validateEndpoint(endpoint));
  }
});

test('MCP stdio discovery works offline and connection failures are actionable', async () => {
  const client = await clientFor('http://127.0.0.1:1');
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 18);
    assert.ok(tools.some(t => t.name === 'page_screenshot'));
    assert.ok(!tools.some(t => t.name.includes('evaluate')));
    const result = await client.callTool({ name: 'browser_status', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Let AI agents control Helide/);
    const invalid = await client.callTool({ name: 'tabs_open', arguments: { url: 'file:///etc/passwd' } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});

// Explicitly opt in: this starts ONLY an isolated headless browser with a fresh
// temporary profile. It never attaches to the user's endpoint or profile.
test('browser integration through real MCP stdio', {
  skip: !process.env.HELIUM_TEST_EXECUTABLE,
  timeout: 90000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'helium-mcp-test-'));
  let context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.HELIUM_TEST_EXECUTABLE, headless: true,
    args: ['--remote-debugging-port=0', '--no-first-run'],
  });
  let client: Client | undefined;
  try {
    let port = '';
    for (let i = 0; i < 50 && !port; i++) {
      port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then(s => s.split('\n')[0]!).catch(() => '');
      if (!port) await sleep(100);
    }
    assert.ok(port, 'headless test browser published its debugging port');
    const personal = context.pages()[0]!;
    await personal.setContent('<title>Personal</title><p>Untouched</p>');
    client = await clientFor(`http://127.0.0.1:${port}`, join(profile, 'artifacts'));
    const call = async (name: string, args: Record<string, unknown> = {}) => decoded(await client!.callTool({ name, arguments: args }));
    assert.equal((await call('browser_status')).connected, true);
    const initial = await call('tabs_list');
    assert.equal(initial[0].owned, false);
    const denied = await client.callTool({ name: 'tabs_close', arguments: { tab_id: initial[0].tab_id } });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /permission/);

    const opened = await call('tabs_open');
    const tab_id = opened.tab_id;
    const owned = context.pages().find(p => p !== personal)!;
    // This fixture's separate Playwright connection must not auto-dismiss
    // dialogs before the MCP connection can handle them.
    owned.on('dialog', () => {});
    await owned.setContent(`<title>Fixture</title>
      <h1>Test page</h1><label>Search<input id="q"></label>
      <input type="password" value="SECRET"><input id="file" type="file" hidden>
      <label><input type="checkbox" id="check">Agree</label>
      <button onclick="document.querySelector('#result').textContent=document.querySelector('#q').value">Submit</button>
      <button onclick="alert('Hello')">Alert</button><p id="result">Ready</p>
      <a download="fixture.txt" href="data:text/plain,download-fixture">Download fixture</a>
      <iframe srcdoc="<button>Frame action</button>"></iframe>
      <div id="shadow"></div>
      <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>'</script>`);
    await owned.locator('iframe').contentFrame().getByRole('button').waitFor();
    const snapshot = await call('page_inspect', { tab_id });
    assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
    assert.ok(snapshot.elements.some((e: any) => e.name === 'Frame action' && e.frame > 0));
    assert.ok(snapshot.elements.some((e: any) => e.name === 'Shadow action'));
    assert.ok(snapshot.elements.some((e: any) => e.type === 'file' && !e.visible));
    const search = snapshot.elements.find((e: any) => e.tag === 'input' && e.name === 'Search');
    assert.ok(search);
    await call('page_fill', { tab_id, fields: [{ ref: search.ref, value: 'A real MCP action' }] });
    const button = await call('page_find', { tab_id, text: 'Submit', role: 'button' });
    await call('page_click', { tab_id, ref: button.matches[0].ref });
    assert.match((await call('page_read', { tab_id })).text, /A real MCP action/);
    await call('page_wait', { tab_id, text: 'A real MCP action' });
    const screenshot = await client.callTool({ name: 'page_screenshot', arguments: { tab_id } });
    assert.equal((screenshot.content as any[])[0].type, 'image');
    const alert = await call('page_find', { tab_id, text: 'Alert', role: 'button' });
    const clicked = await call('page_click', { tab_id, ref: alert.matches[0].ref });
    assert.equal(clicked.dialog.message, 'Hello');
    await call('page_dialog', { tab_id, accept: true });
    const fixturePath = join(profile, 'upload.txt');
    await writeFile(fixturePath, 'upload fixture');
    const file = snapshot.elements.find((e: any) => e.type === 'file');
    await call('page_upload', { tab_id, ref: file.ref, paths: [fixturePath] });
    assert.equal(await owned.locator('#file').evaluate((el: HTMLInputElement) => el.files?.[0]?.name), 'upload.txt');
    const checkbox = snapshot.elements.find((e: any) => e.type === 'checkbox');
    await call('page_fill', { tab_id, fields: [{ ref: checkbox.ref, checked: true }] });
    assert.equal(await owned.locator('#check').isChecked(), true);
    await call('page_press_key', { tab_id, ref: search.ref, key: 'End' });
    await call('page_scroll', { tab_id, y: 10 });
    const link = await call('page_find', { tab_id, role: 'link', text: 'Download fixture' });
    await call('page_click', { tab_id, ref: link.matches[0].ref });
    let downloads: any[] = [];
    for (let i = 0; i < 30 && !downloads.length; i++) {
      downloads = await call('downloads_list', { tab_id });
      if (!downloads.length) await sleep(50);
    }
    assert.equal(downloads.length, 1);
    const saved = await call('downloads_wait', { download_id: downloads[0].download_id });
    assert.equal(await readFile(saved.path, 'utf8'), 'download-fixture');
    await call('page_inspect', { tab_id });
    const stale = await client.callTool({ name: 'page_click', arguments: { tab_id, ref: button.matches[0].ref } });
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale.content), /Stale/);
    await call('page_navigate', { tab_id, url: 'about:blank' });
    await call('tabs_close', { tab_id });
    assert.equal(await personal.title(), 'Personal');
    await client.close();
    client = undefined;
    assert.equal(await personal.title(), 'Personal', 'MCP shutdown did not close the browser');

    // Keep an MCP session alive across a real browser stop/restart.
    client = await clientFor(`http://127.0.0.1:${port}`, join(profile, 'artifacts'));
    const beforeRestart = await call('tabs_list');
    await context.close();
    const offline = await client.callTool({ name: 'browser_status', arguments: {} });
    assert.equal(offline.isError, true);
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.HELIUM_TEST_EXECUTABLE, headless: true,
      args: [`--remote-debugging-port=${port}`, '--no-first-run'],
    });
    assert.equal((await call('browser_status')).connected, true);
    const afterRestart = await call('tabs_list');
    assert.ok(afterRestart.every((t: any) => !t.owned));
    assert.ok(afterRestart.every((t: any) => !beforeRestart.some((old: any) => old.tab_id === t.tab_id)));
    const staleTab = await client.callTool({ name: 'page_read', arguments: { tab_id: beforeRestart[0].tab_id } });
    assert.equal(staleTab.isError, true);
  } finally {
    await client?.close();
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
