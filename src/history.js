// Snapshot history in a local JSON file: append, diff and summarize growth.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export const HISTORY_VERSION = 1;
export const DEFAULT_HISTORY_FILE = 'moons-history.json';

export function loadHistory(file) {
  if (!existsSync(file)) return { version: HISTORY_VERSION, snapshots: [] };
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`History file ${file} is not valid JSON: ${err.message}`);
  }
  if (!data || !Array.isArray(data.snapshots)) throw new Error(`History file ${file} has no "snapshots" array`);
  return data;
}

/** Write atomically: temp file then rename. */
export function saveHistory(file, history) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(history)}\n`);
  renameSync(tmp, file);
}

export function snapshotFromReport(r) {
  const m = r.metrics;
  return {
    t: r.fetchedAt,
    mint: r.mint,
    chain: r.chain,
    symbol: r.quote?.symbol ?? null,
    pairs: m.totalPairs,
    activePairs: m.activePairs,
    volume24h: Math.round(m.volume24h),
    liquidityUsd: Math.round(m.liquidityUsd),
    flowUsd: Math.round(m.flowUsd),
    health: r.health.score,
    top3Share: m.top3Share == null ? null : Math.round(m.top3Share * 1000) / 1000,
    new24h: m.new24h,
    new7d: m.new7d,
    pairAddresses: r.pairs.map((p) => p.pairAddress),
  };
}

export function lastSnapshot(history, mint, chain) {
  for (let i = history.snapshots.length - 1; i >= 0; i--) {
    const s = history.snapshots[i];
    if (s.mint === mint && s.chain === chain) return s;
  }
  return null;
}

const DELTA_KEYS = ['pairs', 'activePairs', 'volume24h', 'liquidityUsd', 'flowUsd', 'health', 'new24h'];

/** Difference between two snapshots of the same token. */
export function computeDelta(prev, cur) {
  if (!prev) return null;
  const out = { elapsedMs: cur.t - prev.t };
  for (const k of DELTA_KEYS) out[k] = (cur[k] ?? 0) - (prev[k] ?? 0);
  const before = new Set(prev.pairAddresses || []);
  const after = new Set(cur.pairAddresses || []);
  out.newPairs = [...after].filter((a) => !before.has(a));
  out.removedPairs = [...before].filter((a) => !after.has(a)).length;
  return out;
}

/** Append a report's snapshot to the file. Returns snapshot, previous and delta. */
export function recordSnapshot(file, report, { maxSnapshots = 5000 } = {}) {
  const history = loadHistory(file);
  const snapshot = snapshotFromReport(report);
  const previous = lastSnapshot(history, report.mint, report.chain);
  history.version = HISTORY_VERSION;
  history.snapshots.push(snapshot);
  if (history.snapshots.length > maxSnapshots) history.snapshots.splice(0, history.snapshots.length - maxSnapshots);
  saveHistory(file, history);
  return { snapshot, previous, delta: computeDelta(previous, snapshot) };
}

/** Group snapshots per token and compute growth from first to last point. */
export function historySeries(history, { mint, chain } = {}) {
  const groups = new Map();
  for (const s of history.snapshots) {
    if (mint && s.mint !== mint) continue;
    if (chain && s.chain !== chain) continue;
    const key = `${s.chain}:${s.mint}`;
    if (!groups.has(key)) groups.set(key, { mint: s.mint, chain: s.chain, symbol: s.symbol, points: [] });
    const g = groups.get(key);
    g.symbol = s.symbol ?? g.symbol;
    g.points.push(s);
  }
  return [...groups.values()].map((g) => {
    g.points.sort((a, b) => a.t - b.t);
    const first = g.points[0];
    const last = g.points.at(-1);
    const seen = new Set();
    for (const p of g.points) for (const a of p.pairAddresses || []) seen.add(a);
    return {
      ...g,
      growth: {
        from: first.t,
        to: last.t,
        snapshots: g.points.length,
        ...Object.fromEntries(DELTA_KEYS.map((k) => [k, (last[k] ?? 0) - (first[k] ?? 0)])),
        uniquePairsSeen: seen.size,
      },
    };
  });
}
