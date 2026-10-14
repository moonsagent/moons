import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterByQuote, toRow, quoteInfo, estimateFlow } from '../src/core.js';
import { computeMetrics, healthScore, ecosystemReport, compareTokens, parseSince, newPairsSince } from '../src/ecosystem.js';
import { startMockServer, loadFixture, FIXTURE_MINT, PAD_MINT, FIXTURE_TIME } from '../scripts/mock-server.js';

const rows = () => filterByQuote(loadFixture(), FIXTURE_MINT, 'solana').map(toRow);

test('estimateFlow is the buy share of volume', () => {
  assert.equal(estimateFlow(1000, 3, 1), 750);
  assert.equal(estimateFlow(1000, 0, 0), 0);
  assert.equal(estimateFlow(null, 5, 5), 0);
});

test('quoteInfo picks the most liquid pool where the token is base', () => {
  const q = quoteInfo(loadFixture(), FIXTURE_MINT, 'solana');
  assert.equal(q.symbol, 'MOONS');
  assert.equal(q.marketCap, 10100000);
  assert.equal(q.mainPool.pairAddress, 'PairSOL1111111111111111111111111111111111111');
  assert.equal(quoteInfo([], 'x', 'solana').mainPool, null);
});

test('computeMetrics: flow, concentration, growth', () => {
  const m = computeMetrics(rows(), FIXTURE_TIME);
  assert.equal(m.totalPairs, 6);
  assert.equal(m.activePairs, 5);
  assert.equal(Math.round(m.flowUsd), 417179);
  assert.equal(m.buys24h, 5199);
  assert.equal(m.sells24h, 5134);
  assert.deepEqual(m.top3, ['MWHALE', 'EDOG', 'TESTFROGGYLONGTICKER']);
  assert.equal(m.top3Share.toFixed(3), '0.945');
  assert.equal(m.new24h, 2);
  assert.equal(m.new7d, 4);
  assert.equal(m.deepPairs, 4);
  assert.equal(m.routedShare, null, 'no routing data without enrichment');
});

test('healthScore: documented components add up to the score', () => {
  const h = healthScore(computeMetrics(rows(), FIXTURE_TIME));
  assert.deepEqual(h.components.map((c) => c.max), [20, 25, 20, 15, 10, 10]);
  const sum = h.components.reduce((a, c) => a + c.points, 0);
  assert.equal(h.score, Math.round(sum));
  assert.equal(h.score, 62);
  assert.equal(h.grade, 'moderate');
  const empty = healthScore(computeMetrics([], FIXTURE_TIME));
  assert.equal(empty.score, 0);
  assert.equal(empty.grade, 'weak');
});

test('ecosystemReport uses both DexScreener endpoints and computes routing share', async () => {
  const srv = await startMockServer();
  try {
    const r = await ecosystemReport(FIXTURE_MINT, { apiBase: srv.url, now: FIXTURE_TIME });
    assert.equal(r.metrics.totalPairs, 6);
    assert.equal(r.quote.symbol, 'MOONS');
    assert.ok(r.flowToMcap > 0.04 && r.flowToMcap < 0.042);
    const edog = r.pairs.find((p) => p.baseSymbol === 'EDOG');
    assert.equal(edog.routeShare.toFixed(3), (184230.5 / (184230.5 + 61400)).toFixed(3));
    assert.ok(r.metrics.routedShare > 0.6 && r.metrics.routedShare < 0.7);
    assert.ok(srv.state.requests.some((u) => u.startsWith('/tokens/v1/solana/')));
    const batch = srv.state.requests.find((u) => u.startsWith('/tokens/v1/'));
    assert.equal(decodeURIComponent(batch.split('/').pop()).split(',').length, 6);
  } finally {
    await srv.close();
  }
});

test('ecosystemReport with enrich false makes a single request', async () => {
  const srv = await startMockServer();
  try {
    const r = await ecosystemReport(FIXTURE_MINT, { apiBase: srv.url, enrich: false, cacheTtl: 0 });
    assert.equal(r.metrics.routedShare, null);
    assert.equal(srv.state.requests.length, 1);
  } finally {
    await srv.close();
  }
});

test('compareTokens builds a side by side table with leaders', async () => {
  const srv = await startMockServer();
  try {
    const c = await compareTokens([FIXTURE_MINT, PAD_MINT], { apiBase: srv.url, now: FIXTURE_TIME });
    assert.deepEqual(c.labels, ['MOONS', 'PAD']);
    const pairs = c.metrics.find((m) => m.key === 'pairs');
    assert.deepEqual(pairs.values, [6, 4]);
    assert.equal(pairs.leader, 0);
    assert.equal(c.metrics.find((m) => m.key === 'buyRatio').leader, 1);
    assert.equal(c.metrics.find((m) => m.key === 'top3Share').leader, null);
    await assert.rejects(compareTokens([FIXTURE_MINT]), /at least two/);
  } finally {
    await srv.close();
  }
});

test('parseSince accepts durations, dates and unix timestamps', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  assert.equal(parseSince('24h', now), now - 86400e3);
  assert.equal(parseSince('7d', now), now - 7 * 86400e3);
  assert.equal(parseSince('90m', now), now - 90 * 60e3);
  assert.equal(parseSince('2026-10-13T00:00:00Z', now), Date.parse('2026-10-13T00:00:00Z'));
  assert.equal(parseSince('1791900000', now), 1791900000 * 1000);
  assert.equal(parseSince(1791900000000, now), 1791900000000);
  assert.throws(() => parseSince('soon', now), /Cannot parse/);
});

test('newPairsSince returns pairs created after the cutoff, newest first', async () => {
  const srv = await startMockServer();
  try {
    const r = await newPairsSince(FIXTURE_MINT, '24h', { apiBase: srv.url, now: FIXTURE_TIME });
    assert.equal(r.count, 2);
    assert.deepEqual(r.pairs.map((p) => p.baseSymbol), ['FRESH', 'SCAT']);
  } finally {
    await srv.close();
  }
});
