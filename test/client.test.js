import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, retryAfterMs, fetchTokensBatch, fetchOhlcv, fetchTokenPairs, createLimiter, geckoNetwork, clearCache, redact } from '../src/client.js';
import { quotePriceHistory } from '../src/ohlcv.js';
import { startMockServer, FIXTURE_MINT } from '../scripts/mock-server.js';

test('retryAfterMs parses seconds and HTTP dates', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs('0'), 0);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs('junk'), null);
  const now = Date.parse('2026-10-14T12:00:00Z');
  assert.equal(retryAfterMs('Wed, 14 Oct 2026 12:00:05 GMT', now), 5000);
});

test('requestJson honours Retry-After on 429', async () => {
  const srv = await startMockServer({ failures: 1, retryAfter: '1' });
  try {
    const t0 = Date.now();
    await requestJson(`${srv.url}/token-pairs/v1/solana/${FIXTURE_MINT}`, { baseDelay: 1 });
    assert.ok(Date.now() - t0 >= 900, 'waited about one second');
    assert.equal(srv.state.requests.length, 2);
  } finally {
    await srv.close();
  }
});

test('responses are cached in memory for cacheTtl', async () => {
  clearCache();
  const srv = await startMockServer();
  try {
    await fetchTokenPairs('solana', FIXTURE_MINT, { apiBase: srv.url });
    await fetchTokenPairs('solana', FIXTURE_MINT, { apiBase: srv.url });
    assert.equal(srv.state.requests.length, 1);
    await fetchTokenPairs('solana', FIXTURE_MINT, { apiBase: srv.url, cacheTtl: 0 });
    assert.equal(srv.state.requests.length, 2);
  } finally {
    clearCache();
    await srv.close();
  }
});

test('fetchTokensBatch splits into chunks of 30 addresses', async () => {
  const srv = await startMockServer();
  try {
    const addrs = Array.from({ length: 35 }, (_, i) => `Addr${i}`);
    addrs.push('BaseAAA111111111111111111111111111111111pump', 'Addr0');
    const pools = await fetchTokensBatch('solana', addrs, { apiBase: srv.url, cacheTtl: 0 });
    const batches = srv.state.requests.filter((u) => u.startsWith('/tokens/v1/'));
    assert.equal(batches.length, 2);
    assert.equal(decodeURIComponent(batches[0].split('/').pop()).split(',').length, 30);
    assert.ok(pools.some((p) => p.pairAddress === 'PairEdogSOL1111111111111111111111111111111111'));
  } finally {
    await srv.close();
  }
});

test('fetchOhlcv parses GeckoTerminal candles oldest first', async () => {
  const srv = await startMockServer();
  try {
    const c = await fetchOhlcv('solana', 'PairSOL1111111111111111111111111111111111111', { geckoBase: srv.gecko, cacheTtl: 0 });
    assert.equal(c.length, 72);
    assert.ok(c[0].t < c[1].t);
    assert.equal(typeof c[0].o, 'number');
    assert.match(srv.state.requests[0], /^\/gecko\/networks\/solana\/pools\/PairSOL1+\/ohlcv\/hour\?aggregate=1&limit=100$/);
    await assert.rejects(fetchOhlcv('solana', 'x', { timeframe: 'week' }), /timeframe/);
    assert.equal(geckoNetwork('ethereum'), 'eth');
    assert.equal(geckoNetwork('solana'), 'solana');
  } finally {
    await srv.close();
  }
});

test('quotePriceHistory finds the main pool and reports change', async () => {
  const srv = await startMockServer();
  try {
    const h = await quotePriceHistory(FIXTURE_MINT, { apiBase: srv.url, geckoBase: srv.gecko, cacheTtl: 0 });
    assert.equal(h.pool.pairAddress, 'PairSOL1111111111111111111111111111111111111');
    assert.equal(h.candles.length, 72);
    assert.ok(h.change > 0);
    const none = await quotePriceHistory('Unknown', { apiBase: srv.url, geckoBase: srv.gecko, cacheTtl: 0 });
    assert.equal(none.pool, null);
  } finally {
    await srv.close();
  }
});

test('createLimiter waits once the window is full', async () => {
  const acquire = createLimiter(2, 80);
  const t0 = Date.now();
  await acquire();
  await acquire();
  await acquire();
  assert.ok(Date.now() - t0 >= 70);
});

test('redact hides Telegram bot tokens', () => {
  assert.equal(redact('https://api.telegram.org/bot123:abc/sendMessage'), 'https://api.telegram.org/bot<redacted>/sendMessage');
});
