#!/usr/bin/env node
// Isolated UI/persistence smoke test. Never uses the real browser profile.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '../mcp/node_modules/playwright-core/index.mjs';

const executablePath = process.env.HELIDE_TEST_EXECUTABLE ??
    fileURLToPath(new URL('../build/src/out/Default/helium', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'helide-window-close-'));
let context;

async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, locale: 'en-US', args: ['--no-first-run'],
  });
}

async function toolbar() {
  const page = await context.newPage();
  // Direct WebUI navigation keeps this test independent of menu wording.
  await page.goto('chrome://customize-chrome-side-panel.top-chrome/');
  await page.locator('#toolbarButton').click();
  const row = page.locator('.toggle-container').filter({ hasText: 'Show window close button' });
  await row.waitFor();
  return { page, row, toggle: row.locator('cr-toggle') };
}

async function waitChecked(toggle, value) {
  for (let i = 0; i < 100; i++) {
    if (await toggle.evaluate((el, expected) => el.checked === expected, value)) return;
    await sleep(50);
  }
  assert.fail(`Expected close-button toggle checked=${value}`);
}

async function savedValue() {
  const prefs = JSON.parse(await readFile(join(profile, 'Default/Preferences'), 'utf8'));
  return prefs.helium?.browser?.show_window_close_button;
}

try {
  await launch();
  const first = await toolbar();
  const second = await toolbar();
  await waitChecked(first.toggle, true);
  await waitChecked(second.toggle, true);
  console.log('PASS: close button defaults to shown');

  await first.row.locator('.toggle-title').click();
  await waitChecked(first.toggle, false);
  await waitChecked(second.toggle, false);
  assert.equal(await first.page.locator('#resetToDefaultButton').evaluate(el => el.disabled), false);
  console.log('PASS: toggle updates live in two customization pages; reset is enabled');

  await context.close();
  assert.equal(await savedValue(), false);
  await launch();
  const restored = await toolbar();
  await waitChecked(restored.toggle, false);
  console.log('PASS: hidden preference survives browser restart');

  await restored.page.locator('#resetToDefaultButton').click();
  await waitChecked(restored.toggle, true);
  await context.close();
  assert.notEqual(await savedValue(), false);
  await launch();
  const reset = await toolbar();
  await waitChecked(reset.toggle, true);
  console.log('PASS: Reset to default restores the close-button preference across restart');
  console.log('Visual caption-button visibility/layout still needs a Wayland window check.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
