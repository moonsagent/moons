// Ecosystem analytics for a quote token: flow estimate, concentration,
// growth, routing share and the pairing health score.
import { fetchTokensBatch } from './client.js';
import { loadPairs, sortRows, summarize, isPump, sameAddress } from './core.js';
import { compactUsd } from './format.js';

const H = 3600_000;
const D = 24 * H;
export const ACTIVE_VOLUME_USD = 1000;
export const DEEP_LIQUIDITY_USD = 10_000;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** Aggregate ecosystem metrics over rows quoted in one token. */
export function computeMetrics(rows, now = Date.now()) {
  const s = summarize(rows);
  let flowUsd = 0;
  let buys = 0;
  let sells = 0;
  let active = 0;
  let deep = 0;
  let new24h = 0;
  let new7d = 0;
  for (const r of rows) {
    flowUsd += r.flowUsd;
    buys += r.buys24h;
    sells += r.sells24h;
    if (r.volume24h >= ACTIVE_VOLUME_USD) active++;
    if ((r.liquidityUsd ?? 0) >= DEEP_LIQUIDITY_USD) deep++;
    if (r.createdAt != null && now - r.createdAt <= D) new24h++;
    if (r.createdAt != null && now - r.createdAt <= 7 * D) new7d++;
  }
  const byVol = sortRows(rows, 'volume');
  const top3 = byVol.slice(0, 3).reduce((a, r) => a + r.volume24h, 0);
  const hhi = s.volume24h > 0 ? rows.reduce((a, r) => a + (r.volume24h / s.volume24h) ** 2, 0) : 1;
  const enriched = rows.filter((r) => r.coinVolume24h != null);
  const coinVol = enriched.reduce((a, r) => a + r.coinVolume24h, 0);
  const viaQuote = enriched.reduce((a, r) => a + r.volume24h, 0);
  return {
    totalPairs: rows.length,
    activePairs: active,
    volume24h: s.volume24h,
    liquidityUsd: s.liquidityUsd,
    flowUsd,
    buys24h: buys,
    sells24h: sells,
    buyRatio: buys + sells > 0 ? buys / (buys + sells) : null,
    top3Share: s.volume24h > 0 ? top3 / s.volume24h : null,
    top3: byVol.slice(0, 3).map((r) => r.baseSymbol),
    hhi,
    deepPairs: deep,
    new24h,
    new7d,
    pumpPairs: rows.filter((r) => isPump(r.dexId)).length,
    routedShare: coinVol > 0 ? viaQuote / coinVol : null,
    newest: s.newest,
    biggest: s.biggest,
  };
}

/**
 * Pairing health, 0 to 100. Six documented components:
 *   breadth (20)          active pairs (24h volume >= $1K), log scale, full at 50
 *   flow (25)             estimated 24h flow into quote, log scale, full at $1M
 *   diversification (20)  1 minus the Herfindahl index of volume shares
 *   growth (15)           pairs created in the last 7 days, full at 10
 *   depth (10)            share of pairs with liquidity >= $10K
 *   buy pressure (10)     buys / (buys + sells): 40% scores 0, 60% or more scores full
 */
export function healthScore(m) {
  const parts = [
    ['breadth', 'Breadth', 20, Math.log10(1 + m.activePairs) / Math.log10(51), `${m.activePairs} active`],
    ['flow', 'Flow', 25, Math.log10(1 + m.flowUsd) / 6, `${compactUsd(m.flowUsd)} est.`],
    ['diversification', 'Diversification', 20, m.volume24h > 0 ? 1 - m.hhi : 0, `HHI ${round(m.hhi)}`],
    ['growth', 'Growth', 15, m.new7d / 10, `${m.new7d} new in 7d`],
    ['depth', 'Depth', 10, m.totalPairs ? m.deepPairs / m.totalPairs : 0, `${m.deepPairs}/${m.totalPairs} deep`],
    ['buyPressure', 'Buy pressure', 10, m.buyRatio == null ? 0 : (m.buyRatio - 0.4) / 0.2, m.buyRatio == null ? 'no trades' : `${Math.round(m.buyRatio * 100)}% buys`],
  ];
  const components = parts.map(([key, label, max, ratio, detail]) => ({
    key,
    label,
    max,
    points: round(clamp01(ratio) * max, 1),
    detail,
  }));
  const score = Math.round(components.reduce((a, c) => a + c.points, 0));
  const grade = score >= 70 ? 'strong' : score >= 40 ? 'moderate' : 'weak';
  return { score, grade, components };
}

/**
 * Use the batch endpoint to measure, per paired coin, how much of its total
 * volume on this chain trades through the quote pair (routeShare).
 */
export async function enrichRouting(rows, mint, chain, opts = {}) {
  const pools = await fetchTokensBatch(chain, rows.map((r) => r.baseAddress), opts);
  const totals = new Map();
  const seen = new Set();
  for (const p of pools) {
    if (!p?.pairAddress || seen.has(p.pairAddress) || (p.chainId && p.chainId !== chain)) continue;
    seen.add(p.pairAddress);
    const vol = Number(p.volume?.h24) || 0;
    for (const side of [p.baseToken?.address, p.quoteToken?.address]) {
      if (!side || sameAddress(side, mint, chain)) continue;
      totals.set(side, (totals.get(side) || 0) + vol);
    }
  }
  for (const r of rows) {
    if (!totals.has(r.baseAddress)) continue;
    const total = Math.max(totals.get(r.baseAddress), r.volume24h);
    r.coinVolume24h = total;
    r.routeShare = total > 0 ? r.volume24h / total : null;
  }
  return rows;
}

/**
 * Full ecosystem report for a quote token.
 * options: chain, minLiquidity, sort, limit, enrich (default true), now, apiBase, plus client options.
 */
export async function ecosystemReport(mint, options = {}) {
  const { chain = 'solana', sort = 'volume', limit = 0, enrich = true, now = Date.now() } = options;
  const { rows, quote, apiBase } = await loadPairs(mint, { ...options, chain });
  let enrichError = null;
  if (enrich && rows.length) {
    try {
      await enrichRouting(rows, mint, chain, { ...options, apiBase });
    } catch (err) {
      enrichError = err.message;
    }
  }
  const metrics = computeMetrics(rows, now);
  const sorted = sortRows(rows, sort);
  const pairs = limit > 0 ? sorted.slice(0, limit) : sorted;
  return {
    mint,
    chain,
    fetchedAt: now,
    quote,
    metrics,
    health: healthScore(metrics),
    flowToMcap: quote.marketCap ? metrics.flowUsd / quote.marketCap : null,
    summary: summarize(rows),
    enrichError,
    pairs,
  };
}

/** Run reports for several quote tokens (sequentially, to stay inside rate limits). */
export async function compareTokens(mints, options = {}) {
  if (!Array.isArray(mints) || mints.length < 2) throw new TypeError('compare needs at least two token addresses');
  const reports = [];
  for (const m of mints) reports.push(await ecosystemReport(m, options));
  const label = (r) => r.quote.symbol || `${r.mint.slice(0, 6)}..`;
  const pick = (fn) => reports.map(fn);
  const winner = (vals) => {
    let best = -1;
    vals.forEach((v, i) => { if (v != null && (best < 0 || v > vals[best])) best = i; });
    return best >= 0 && vals.filter((v) => v === vals[best]).length > 1 ? -1 : best;
  };
  const metrics = [
    ['health', 'Health score', pick((r) => r.health.score)],
    ['pairs', 'Pairs', pick((r) => r.metrics.totalPairs)],
    ['activePairs', 'Active pairs', pick((r) => r.metrics.activePairs)],
    ['volume24h', 'Volume 24h', pick((r) => r.metrics.volume24h)],
    ['flowUsd', 'Flow into quote (est.)', pick((r) => r.metrics.flowUsd)],
    ['liquidityUsd', 'Liquidity', pick((r) => r.metrics.liquidityUsd)],
    ['new24h', 'New pairs 24h', pick((r) => r.metrics.new24h)],
    ['new7d', 'New pairs 7d', pick((r) => r.metrics.new7d)],
    ['top3Share', 'Top 3 share', pick((r) => r.metrics.top3Share)],
    ['buyRatio', 'Buy ratio', pick((r) => r.metrics.buyRatio)],
  ].map(([key, label, values]) => ({ key, label, values, leader: key === 'top3Share' ? null : winner(values) }));
  return { chain: options.chain || 'solana', labels: reports.map(label), metrics, reports };
}

/**
 * Parse a "since" value: duration ("90m", "24h", "7d"), ISO date, or unix
 * seconds / milliseconds. Returns a timestamp in ms.
 */
export function parseSince(value, now = Date.now()) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const s = String(value ?? '').trim();
  const dur = s.match(/^(\d+(?:\.\d+)?)\s*(m|h|d)$/i);
  if (dur) return now - Number(dur[1]) * { m: 60_000, h: H, d: D }[dur[2].toLowerCase()];
  if (/^\d+$/.test(s)) return parseSince(Number(s), now);
  const t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  throw new TypeError(`Cannot parse since="${value}". Use a duration like 24h or 7d, an ISO date, or a unix timestamp.`);
}

/** Pairs quoted in `mint` that were created at or after `since`. */
export async function newPairsSince(mint, since, options = {}) {
  const now = options.now ?? Date.now();
  const t = parseSince(since, now);
  const { rows, quote } = await loadPairs(mint, options);
  const pairs = sortRows(rows.filter((r) => r.createdAt != null && r.createdAt >= t), 'age');
  return { mint, chain: options.chain || 'solana', quote, since: new Date(t).toISOString(), count: pairs.length, pairs };
}
