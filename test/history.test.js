import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHistory, recordSnapshot, computeDelta, historySeries, snapshotFromReport } from '../src/history.js';

const report = (t, pairs, extra = {}) => ({
  mint: 'Q', chain: 'solana', fetchedAt: t, quote: { symbol: 'Q' },
  metrics: { totalPairs: pairs.length, activePairs: pairs.length, volume24h: 1000 * pairs.length, liquidityUsd: 500, flowUsd: 600 * pairs.length, top3Share: 1, new24h: 0, new7d: 0, ...extra },
  health: { score: 10 * pairs.length },
  pairs: pairs.map((a) => ({ pairAddress: a })),
});

test('loadHistory returns an empty history for a missing file and rejects bad JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moons-'));
  assert.deepEqual(loadHistory(join(dir, 'none.json')).snapshots, []);
  writeFileSync(join(dir, 'bad.json'), '{oops');
  assert.throws(() => loadHistory(join(dir, 'bad.json')), /not valid JSON/);
  writeFileSync(join(dir, 'odd.json'), '{}');
  assert.throws(() => loadHistory(join(dir, 'odd.json')), /snapshots/);
});

test('recordSnapshot appends and returns the delta against the previous snapshot', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'moons-')), 'h.json');
  const a = recordSnapshot(file, report(1000, ['p1', 'p2']));
  assert.equal(a.previous, null);
  assert.equal(a.delta, null);
  const b = recordSnapshot(file, report(61000, ['p2', 'p3', 'p4']));
  assert.equal(b.delta.pairs, 1);
  assert.equal(b.delta.flowUsd, 600);
  assert.equal(b.delta.health, 10);
  assert.equal(b.delta.elapsedMs, 60000);
  assert.deepEqual(b.delta.newPairs, ['p3', 'p4']);
  assert.equal(b.delta.removedPairs, 1);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.snapshots.length, 2);
});

test('recordSnapshot keeps at most maxSnapshots', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'moons-')), 'h.json');
  for (let i = 0; i < 5; i++) recordSnapshot(file, report(i, ['p']), { maxSnapshots: 3 });
  assert.deepEqual(loadHistory(file).snapshots.map((s) => s.t), [2, 3, 4]);
});

test('historySeries groups by token and computes growth', () => {
  const s1 = snapshotFromReport(report(1, ['a']));
  const s2 = snapshotFromReport(report(2, ['a', 'b', 'c']));
  const other = { ...snapshotFromReport(report(3, ['x'])), mint: 'R' };
  const series = historySeries({ snapshots: [s2, other, s1] });
  assert.equal(series.length, 2);
  const q = series.find((s) => s.mint === 'Q');
  assert.deepEqual(q.points.map((p) => p.t), [1, 2]);
  assert.equal(q.growth.pairs, 2);
  assert.equal(q.growth.uniquePairsSeen, 3);
  assert.equal(historySeries({ snapshots: [s1, other] }, { mint: 'R' }).length, 1);
  assert.equal(computeDelta(null, s1), null);
});
