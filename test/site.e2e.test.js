// End to end: the real page in headless Chromium against the mock API.
// Needs Playwright, which is not a dependency: set PLAYWRIGHT_MODULE (path to
// playwright's index.mjs) and optionally PLAYWRIGHT_CHROMIUM. Skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startMockServer, HUB_MINT, FIXTURE_MINT } from '../scripts/mock-server.js';
import { startSite } from '../scripts/dev-site.mjs';
import { EXAMPLES } from '../docs/app.js';

const MOD = process.env.PLAYWRIGHT_MODULE || '/home/claude/src-reels/tools/node_modules/playwright/index.mjs';
const EXE = process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium';
let chromium = null;
if (existsSync(MOD)) {
  try { ({ chromium } = await import(MOD)); } catch { chromium = null; }
}
const skip = chromium ? false : 'playwright not installed (set PLAYWRIGHT_MODULE)';

async function withPage(width, fn, mockOpts = { rebase: true }) {
  const site = await startSite();
  const mock = await startMockServer(mockOpts);
  const browser = await chromium.launch(existsSync(EXE) ? { executablePath: EXE } : {});
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await fn(page, `${site.url}/?api=${encodeURIComponent(mock.url)}`, mock);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await mock.close();
    await site.close();
  }
}

test('type a token, scan, see the report, sort, share', { skip, timeout: 60_000 }, async () => {
  await withPage(1440, async (page, base) => {
    await page.goto(base);
    await page.waitForSelector('#chain option', { state: 'attached' });
    await page.fill('#token', `https://pump.fun/coin/${HUB_MINT}`);
    await page.click('button.go');
    await page.waitForSelector('.gauge .sc small');
    assert.equal(await page.inputValue('#token'), HUB_MINT, 'link reduced to the address');
    assert.equal(await page.textContent('.sym'), 'HUB Hub Example');
    assert.match(await page.textContent('.say'), /^28 pairs, \$\d.*est\. flow back, health \d+\/100$/);
    assert.equal(await page.locator('[data-graph] svg .mn-n').count(), 28);
    assert.equal(await page.locator('[data-table] tbody tr').count(), 28);
    await page.waitForSelector('[data-price] svg');
    assert.match(page.url(), new RegExp(`token=${HUB_MINT}`));
    // sort by DEX ascending
    await page.click('th[data-k="dexId"] button');
    assert.equal(await page.getAttribute('th[data-k="dexId"]', 'class'), 'on');
    const first = await page.textContent('[data-table] tbody tr:first-child td:nth-child(2)');
    assert.equal(first, 'meteora');
  });
});

test('share link auto runs, errors and empty states are human', { skip, timeout: 60_000 }, async () => {
  await withPage(390, async (page, base) => {
    await page.goto(`${base}&token=${HUB_MINT}`);
    await page.waitForSelector('.gauge .sc small');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'no horizontal scroll at 390px');
    assert.match(await page.getAttribute('[data-graph] svg', 'viewBox'), /0 0 480 600/);

    await page.goto(`${base}&token=nothex`);
    await page.waitForSelector('.msg[data-kind="bad"]');
    await page.goto(`${base}&token=NoSuchMint1111111111111111111111111111pump`);
    await page.waitForSelector('.msg[data-kind="notfound"]');
    // example link fills the input and runs (the mock does not know it, so: not found)
    await page.click(`.ex a[data-example="${EXAMPLES[0].token}"]`);
    await page.waitForSelector('.msg[data-kind="notfound"]');
    assert.equal(await page.inputValue('#token'), EXAMPLES[0].token);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  });
});

test('rate limits show a rate limited message, not an empty report', { skip, timeout: 60_000 }, async () => {
  await withPage(1440, async (page, base) => {
    await page.goto(`${base}&token=${FIXTURE_MINT}`);
    await page.waitForSelector('.msg[data-kind="rate"]', { timeout: 20_000 });
    assert.match(await page.textContent('.msg h2'), /rate limited/);
  }, { failures: 999, retryAfter: 0 });
});
