import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, renderGraphSvg, renderGraphHtml, MAX_NODES, esc } from '../src/graph.js';
import { filterByQuote, toRow } from '../src/core.js';
import { loadFixture, FIXTURE_MINT, FIXTURE_TIME } from '../scripts/mock-server.js';

const pairs = () => filterByQuote(loadFixture(), FIXTURE_MINT, 'solana').map(toRow);
const report = () => ({ mint: FIXTURE_MINT, chain: 'solana', fetchedAt: FIXTURE_TIME, quote: { symbol: 'MOONS' }, metrics: { totalPairs: 6, volume24h: 1, flowUsd: 1 }, health: { score: 62 }, pairs: pairs() });

test('layoutGraph places the biggest pair on the inner ring and sizes by volume', () => {
  const { nodes, cx, cy, hidden } = layoutGraph(pairs());
  assert.equal(nodes.length, 6);
  assert.equal(hidden, 0);
  assert.equal(nodes[0].pair.baseSymbol, 'MWHALE');
  assert.equal(nodes[0].r, 30);
  assert.ok(nodes.every((n) => n.r >= 6 && n.r <= 30));
  assert.ok(nodes.every((n) => n.x > 0 && n.x < 960 && n.y > 0 && n.y < 720));
  assert.ok(Math.hypot(nodes[0].x - cx, nodes[0].y - cy) > 100);
});

test('layoutGraph caps the node count', () => {
  const many = Array.from({ length: 75 }, (_, i) => ({ pairAddress: `P${i}`, baseSymbol: `C${i}`, volume24h: 1000 - i, flowUsd: 10 }));
  const g = layoutGraph(many);
  assert.equal(g.nodes.length, MAX_NODES);
  assert.equal(g.hidden, 75 - MAX_NODES);
  assert.match(renderGraphSvg({ pairs: many, quote: { symbol: 'Q' } }), /\+15 smaller pairs not drawn/);
});

test('renderGraphSvg draws one node per pair, marks new pairs, escapes text', () => {
  const r = report();
  r.pairs[0].baseSymbol = '<b>&';
  const svg = renderGraphSvg(r, { now: FIXTURE_TIME });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.equal((svg.match(/class="mn-n"/g) || []).length, 6);
  assert.equal((svg.match(/stroke-dasharray="4 4"/g) || []).length, 2, 'two pairs younger than 24h');
  assert.ok(svg.includes('&lt;b&gt;&amp;'));
  assert.ok(!svg.includes('<b>&'));
  assert.equal(esc(`"'`), '&quot;&#39;');
});

test('renderGraphHtml is self-contained', () => {
  const html = renderGraphHtml(report());
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /window\.moonsGraph/);
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+href=/.test(html), 'no external styles');
  assert.match(html, /MOONS pair network/);
});
