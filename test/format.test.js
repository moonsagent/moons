import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactUsd, formatAge, formatChange, truncate, renderTable, renderCsv, useColor } from '../src/format.js';

test('compactUsd', () => {
  assert.equal(compactUsd(1234567), '$1.2M');
  assert.equal(compactUsd(12100000), '$12.1M');
  assert.equal(compactUsd(184230), '$184K');
  assert.equal(compactUsd(1000), '$1K');
  assert.equal(compactUsd(2.5e9), '$2.5B');
  assert.equal(compactUsd(880), '$880');
  assert.equal(compactUsd(12.5), '$12.5');
  assert.equal(compactUsd(0), '$0');
  assert.equal(compactUsd(0.000412), '$0.00041');
  assert.equal(compactUsd(null), '-');
});

test('formatAge', () => {
  const now = 1_000_000_000_000;
  assert.equal(formatAge(now - 30e3, now), '30s');
  assert.equal(formatAge(now - 25 * 60e3, now), '25m');
  assert.equal(formatAge(now - 3 * 3600e3, now), '3h');
  assert.equal(formatAge(now - 2 * 86400e3, now), '2d');
  assert.equal(formatAge(now - 400 * 86400e3, now), '1y');
  assert.equal(formatAge(null, now), '-');
});

test('formatChange and truncate', () => {
  assert.equal(formatChange(23.44), '+23.4%');
  assert.equal(formatChange(-5), '-5.0%');
  assert.equal(formatChange(null), '-');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
});

const sample = [
  { pairAddress: 'P1', baseSymbol: 'AAA', quoteSymbol: 'Q', dexId: 'pumpswap', priceUsd: 0.01, volume24h: 5000, liquidityUsd: 1000, marketCap: 10000, change24h: 5, buys24h: 1, sells24h: 2, createdAt: 0 },
  { pairAddress: 'P2', baseSymbol: 'B,"x"', quoteSymbol: 'Q', dexId: 'raydium', priceUsd: 2, volume24h: 10, liquidityUsd: null, marketCap: null, change24h: -1, buys24h: 0, sells24h: 0, createdAt: 0 },
];

test('renderTable aligns columns and marks new pairs', () => {
  const out = renderTable(sample, { now: 3600e3, newKeys: new Set(['P2']) });
  const lines = out.split('\n');
  assert.match(lines[0], /^\s+PAIR\s+DEX\s+PRICE/);
  assert.match(lines[2], /^NEW/);
  assert.equal(lines[1].indexOf('pumpswap'), lines[2].indexOf('raydium'));
  assert.ok(!out.includes('\x1b['), 'no ANSI without color');
  const colored = renderTable(sample, { color: true, now: 0 });
  assert.ok(colored.includes('\x1b[32m') && colored.includes('\x1b[31m'));
});

test('renderTable handles empty input', () => {
  assert.match(renderTable([]), /No pairs found/);
});

test('renderCsv escapes values', () => {
  const lines = renderCsv(sample).split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('pairAddress,chainId,dexId'));
  assert.ok(lines[2].includes('"B,""x"""'));
});

test('useColor respects TTY and NO_COLOR', () => {
  assert.equal(useColor({ isTTY: true }, {}), true);
  assert.equal(useColor({ isTTY: true }, { NO_COLOR: '' }), false);
  assert.equal(useColor({ isTTY: false }, {}), false);
});
