import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

// Opt-in smoke test for the fork, not applicable to vanilla Helium.
test('Helide CLI, version page and Settings branding', {
  skip: !process.env.HELIDE_TEST_EXECUTABLE,
  timeout: 60000,
}, async () => {
  const executablePath = process.env.HELIDE_TEST_EXECUTABLE!;
  const { stdout } = await promisify(execFile)(executablePath, ['--version']);
  assert.match(stdout, /^Helide /);
  assert.match(stdout, /Helium fork; Chromium /);
  assert.match(stdout, /Motobook 60 Pro/);
  const profile = await mkdtemp(join(tmpdir(), 'helide-branding-smoke-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, locale: 'en-US', args: ['--no-first-run'],
  });
  try {
    const page = context.pages()[0]!;
    await page.goto('chrome://version');
    const text = await page.locator('body').innerText();
    assert.match(text, /Helide/);
    assert.match(text, /Personal Linux build for Motobook 60 Pro; Helium fork/);
    assert.match(text, /The Helium Authors/);
    const image = page.locator('#logo img');
    assert.equal(await image.evaluate((el: HTMLImageElement) => el.naturalWidth), 140);
    await page.goto('chrome://settings/help');
    await page.getByText('About Helide', { exact: true }).first().waitFor();
    await page.getByText(/Personal Linux build for Motobook 60 Pro/).first().waitFor();
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
