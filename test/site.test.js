// The website (docs/): shared code stays in sync with src, the browser logic
// works against the mock API, and the dev server serves it like Vercel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  parseInput, validateAddress, readParams, shareUrl, apiBases, errorMessage, runReport,
  renderReport, renderSkeleton, renderMessage, renderTable, renderPrice, emptyMessage, graphSize, EXAMPLES, VERSION,
} from '../docs/app.js';
import { ApiError, clearCache } from '../docs/lib/client.js';
import { startMockServer, HUB_MINT, FIXTURE_MINT } from '../scripts/mock-server.js';
import { startSite } from '../scripts/dev-site.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('docs/lib copies are identical to src', () => {
  const files = readdirSync(new URL('../docs/lib/', import.meta.url));
  assert.deepEqual(files.sort(), ['client.js', 'core.js', 'ecosystem.js', 'format.js', 'graph.js', 'ohlcv.js']);
  for (const f of files) assert.equal(read(`docs/lib/${f}`), read(`src/${f}`), `docs/lib/${f} is out of sync, copy src/${f} again`);
});

test('site version matches package.json', () => {
  assert.equal(VERSION, pkg.version);
  assert.match(read('docs/index.html'), new RegExp(`v${pkg.version.replace(/\./g, '\\.')}`));
});

test('parseInput pulls the address out of links and text', () => {
  const sol = 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump';
  const evm = '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b';
  assert.equal(parseInput(`  ${sol} `), sol);
  assert.equal(parseInput(`https://pump.fun/coin/${sol}`), sol);
  assert.equal(parseInput(`https://dexscreener.com/base/${evm}?ref=x`), evm);
  assert.equal(parseInput(`https://solscan.io/token/${sol}#holders`), sol);
  assert.equal(parseInput(''), '');
  assert.equal(parseInput('hello'), 'hello');
});

test('validateAddress gives a human message per chain', () => {
  assert.equal(validateAddress(FIXTURE_MINT, 'solana'), null);
  assert.equal(validateAddress('0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', 'base'), null);
  assert.match(validateAddress('', 'solana'), /paste/);
  assert.match(validateAddress('nothex', 'solana'), /Solana address/);
  assert.match(validateAddress('0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', 'solana'), /EVM address/);
  assert.match(validateAddress(FIXTURE_MINT, 'base'), /switch the chain to solana/);
  assert.match(validateAddress('0x12', 'bsc'), /bsc address/);
});

test('share links round trip through the query string', () => {
  assert.deepEqual(readParams(`?token=${HUB_MINT}`), { token: HUB_MINT, chain: 'solana' });
  assert.deepEqual(readParams(`?mint=${HUB_MINT}&chain=BASE`), { token: HUB_MINT, chain: 'base' });
  assert.deepEqual(readParams('?chain=<script>'), { token: '', chain: 'solana' });
  const loc = { origin: 'https://moonscli.com', pathname: '/' };
  assert.equal(shareUrl(loc, HUB_MINT, 'solana'), `https://moonscli.com/?token=${HUB_MINT}`);
  const url = new URL(shareUrl(loc, '0xabc', 'base'));
  assert.deepEqual(readParams(url.search).chain, 'base');
});

test('the ?api= test override only works on localhost', () => {
  const prod = apiBases({ hostname: 'moonscli.com', search: '?api=http://127.0.0.1:9' });
  assert.equal(prod.apiBase, 'https://api.dexscreener.com');
  assert.equal(prod.geckoBase, 'https://api.geckoterminal.com/api/v2');
  assert.equal(prod.test, null);
  const local = apiBases({ hostname: '127.0.0.1', search: '?api=http://127.0.0.1:8787/' });
  assert.deepEqual(local, { apiBase: 'http://127.0.0.1:8787', geckoBase: 'http://127.0.0.1:8787/gecko', test: 'http://127.0.0.1:8787' });
  assert.equal(apiBases({ hostname: 'localhost', search: '?api=https://evil.example' }).test, null, 'only local http bases');
  assert.equal(apiBases({ hostname: 'localhost', search: '' }, 'http://localhost:1').apiBase, 'http://localhost:1');
});

test('errorMessage maps failures to human messages', () => {
  assert.equal(errorMessage(new ApiError('HTTP 429 from x', 429)).kind, 'rate');
  assert.equal(errorMessage(new ApiError('HTTP 503 from x', 503)).kind, 'api');
  assert.equal(errorMessage(new ApiError('HTTP 404 from x', 404), 'base').detail, 'DexScreener does not know this address on base.');
  assert.equal(errorMessage(new ApiError('Network error requesting x: Failed to fetch')).kind, 'network');
  assert.equal(errorMessage(new Error('weird')).detail, 'weird');
});

test('runReport builds the full report and price line from the mock API', async () => {
  const srv = await startMockServer({ rebase: true });
  try {
    clearCache();
    let early = null;
    const { report, ohlcv } = await runReport(HUB_MINT, 'solana', { apiBase: srv.url, geckoBase: srv.gecko, onReport: (r) => { early = r; } });
    assert.equal(early, report, 'report is handed over before the price line');
    assert.equal(report.metrics.totalPairs, 28);
    assert.equal(report.quote.symbol, 'HUB');
    assert.ok(report.health.score > 0 && report.health.score <= 100);
    assert.equal(ohlcv.candles.length, 72);
    const html = renderReport(report, { ohlcv, viewportWidth: 1440 });
    assert.match(html, /pairing health/);
    assert.match(html, /flow into quote/);
    assert.match(html, /estimate/);
    assert.match(html, /not financial advice/);
    assert.match(html, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 960 640"/);
    assert.match(renderReport(report, { viewportWidth: 390 }), /viewBox="0 0 480 600"/);
    assert.match(renderReport(report, {}), /data-price/, 'price box reserved while loading');
    assert.equal((html.match(/<tr class=/g) || []).length, 28);
    assert.ok(!/[\u2013\u2014]/.test(html), 'no long dashes');
    const byAge = renderTable(report, { key: 'createdAt', dir: -1 });
    assert.ok(byAge.indexOf('th data-k="createdAt" class="on"') > 0);
    // quote not found anywhere: no pairs, no symbol
    const none = await runReport('NoSuchMint1111111111111111111111111111pump', 'solana', { apiBase: srv.url, geckoBase: srv.gecko });
    assert.equal(none.report.pairs.length, 0);
    assert.equal(none.report.quote.symbol, null);
    assert.equal(none.ohlcv, null);
  } finally {
    await srv.close();
  }
});

test('runReport surfaces rate limits as an ApiError with status 429', async () => {
  const srv = await startMockServer({ failures: 99, retryAfter: 0 });
  try {
    clearCache();
    await assert.rejects(runReport(FIXTURE_MINT, 'solana', { apiBase: srv.url, geckoBase: srv.gecko }), (err) => err.status === 429 && errorMessage(err).kind === 'rate');
  } finally {
    await srv.close();
  }
});

test('skeleton, messages and empty state render escaped HTML', () => {
  assert.match(renderSkeleton('<x>', 'solana'), /&lt;x&gt;/);
  const msg = renderMessage({ kind: 'rate', title: 'rate <limited>', detail: 'wait', token: 'T' });
  assert.match(msg, /rate &lt;limited&gt;/);
  assert.match(msg, /data-kind="rate"/);
  for (const e of EXAMPLES) assert.ok(msg.includes(`data-example="${e.token}"`));
  const empty = emptyMessage({ mint: FIXTURE_MINT, quote: { symbol: 'SOLO' } });
  assert.equal(empty.kind, 'empty');
  assert.match(empty.title, /SOLO/);
  assert.match(renderPrice(undefined), /class="sk/);
  assert.match(renderPrice({ candles: [] }, { priceUsd: 0.5 }), /\$0\.5/);
  assert.deepEqual(graphSize(390), { width: 480, height: 600 });
});

test('examples are real addresses for their chains', () => {
  assert.ok(EXAMPLES.length >= 2);
  for (const e of EXAMPLES) assert.equal(validateAddress(e.token, e.chain), null, e.label);
  const html = read('docs/index.html');
  for (const e of EXAMPLES) assert.ok(html.includes(`data-example="${e.token}"`), `${e.label} in the hero`);
});

test('dev server serves docs/ and 404s unknown api routes', async () => {
  const site = await startSite();
  try {
    const page = await fetch(`${site.url}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<script type="module" src="app.js"><\/script>/);
    assert.match(html, /id="token"/);
    assert.ok(!/<script[^>]+src="https?:|<link[^>]+href="https?:/.test(html), 'no external scripts or styles');
    const js = await fetch(`${site.url}/app.js`);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(`${site.url}/lib/core.js`)).status, 200);
    assert.equal((await fetch(`${site.url}/api/nope`)).status, 404);
    assert.equal((await fetch(`${site.url}/../package.json`)).status, 404);
    assert.notEqual((await fetch(`${site.url}/%2e%2e/package.json`)).status, 200);
  } finally {
    await site.close();
  }
});

test('site copy has no long dashes, emojis or hype words', () => {
  for (const f of ['docs/index.html', 'docs/app.js']) {
    const s = read(f);
    assert.ok(!/[\u2013\u2014]/.test(s), `${f}: long dash`);
    assert.ok(!/\p{Extended_Pictographic}/u.test(s), `${f}: emoji`);
    assert.ok(!/\b(revolutionary|game.?changer|seamless|unleash|supercharge|cutting.?edge|moon ?shot|to the moon|100x|guaranteed)\b/i.test(s), `${f}: hype word`);
  }
});
