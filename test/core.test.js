import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterByQuote, sortRows, summarize, diffPairs, toRow, sameAddress } from '../src/index.js';
import { loadFixture, FIXTURE_MINT } from '../scripts/mock-server.js';

const rows = () => filterByQuote(loadFixture(), FIXTURE_MINT, 'solana').map(toRow);

test('filterByQuote keeps only pools quoted in the mint, deduplicated', () => {
  const r = rows();
  assert.equal(r.length, 6);
  assert.ok(r.every((x) => x.quoteSymbol === 'MOONS'));
  assert.ok(!r.some((x) => x.pairAddress === 'PairSOL1111111111111111111111111111111111111'));
  assert.ok(!r.some((x) => x.pairAddress.startsWith('PairCase')), 'solana match is case-sensitive');
});

test('sameAddress is case-insensitive for EVM only', () => {
  const a = '0xAbCdEf0000000000000000000000000000000001';
  assert.ok(sameAddress(a, a.toLowerCase(), 'base'));
  assert.ok(!sameAddress('AbcPump', 'abcpump', 'solana'));
});

test('filterByQuote matches EVM quote addresses regardless of case', () => {
  const q = '0xAbCdEf0000000000000000000000000000000001';
  const pairs = [
    { chainId: 'base', pairAddress: '0x1', quoteToken: { address: q.toLowerCase() } },
    { chainId: 'base', pairAddress: '0x2', quoteToken: { address: '0xdead' } },
  ];
  assert.deepEqual(filterByQuote(pairs, q, 'base').map((p) => p.pairAddress), ['0x1']);
});

test('sortRows orders by each key, nulls last', () => {
  const r = rows();
  assert.equal(sortRows(r, 'volume')[0].baseSymbol, 'MWHALE');
  assert.equal(sortRows(r, 'liquidity')[0].baseSymbol, 'MWHALE');
  assert.equal(sortRows(r, 'liquidity').at(-1).baseSymbol, 'FRESH');
  assert.equal(sortRows(r, 'flow')[0].baseSymbol, 'MWHALE');
  assert.equal(sortRows(r, 'mcap')[1].baseSymbol, 'TESTFROGGYLONGTICKER');
  assert.equal(sortRows(r, 'age')[0].baseSymbol, 'FRESH');
  assert.equal(sortRows(r, 'change')[0].baseSymbol, 'EDOG');
  assert.equal(sortRows(r, 'change').at(-1).baseSymbol, 'FRESH');
  assert.throws(() => sortRows(r, 'nope'), /Unknown sort key/);
});

test('summarize totals and picks newest and biggest', () => {
  const s = summarize(rows());
  assert.equal(s.totalPairs, 6);
  assert.equal(s.pumpPairs, 4);
  assert.equal(Math.round(s.volume24h), 835741);
  assert.equal(s.liquidityUsd, 61200 + 12800 + 220500 + 4100 + 890000);
  assert.equal(s.newest.baseSymbol, 'FRESH');
  assert.equal(s.biggest.baseSymbol, 'MWHALE');
});

test('diffPairs returns nothing on first poll and new pairs afterwards', () => {
  const r = rows();
  assert.deepEqual(diffPairs(null, r), []);
  const prev = new Set(r.slice(0, 4).map((x) => x.pairAddress));
  assert.deepEqual(
    diffPairs(prev, r).map((x) => x.pairAddress),
    r.slice(4).map((x) => x.pairAddress),
  );
  assert.deepEqual(diffPairs(new Set(r.map((x) => x.pairAddress)), r), []);
});
