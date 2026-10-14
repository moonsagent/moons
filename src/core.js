// Core transforms: filter DexScreener pools to the ones quoted in a token,
// flatten them into rows, sort, summarize and diff.
import { fetchTokenPairs, DEFAULT_API } from './client.js';

export const SORT_KEYS = ['volume', 'flow', 'liquidity', 'mcap', 'age', 'change'];
const PUMP_DEXES = new Set(['pumpfun', 'pumpswap', 'pump.fun', 'pumpfunamm']);

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
};

/** EVM addresses are case-insensitive, Solana base58 addresses are not. */
export function sameAddress(a, b, chain) {
  if (!a || !b) return false;
  const evm = /^0x[0-9a-f]{40}$/i.test(a) || (chain && chain !== 'solana' && a.startsWith('0x'));
  return evm ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Estimated USD flow into the quote token for one pair: the buy side of 24h
 * volume, approximated as volume.h24 * buys / (buys + sells). Every buy of a
 * coin quoted in token Q spends Q, so the buyer had to hold or buy Q first.
 */
export function estimateFlow(volume24h, buys, sells) {
  const v = Number(volume24h) || 0;
  const t = (Number(buys) || 0) + (Number(sells) || 0);
  return t > 0 ? (v * (Number(buys) || 0)) / t : 0;
}

/** Flatten a DexScreener pair object into a row. */
export function toRow(p) {
  const volume24h = num(p.volume?.h24) ?? 0;
  const buys24h = num(p.txns?.h24?.buys) ?? 0;
  const sells24h = num(p.txns?.h24?.sells) ?? 0;
  return {
    chainId: p.chainId,
    dexId: p.dexId,
    url: p.url,
    pairAddress: p.pairAddress,
    baseAddress: p.baseToken?.address ?? '',
    baseSymbol: p.baseToken?.symbol ?? '',
    baseName: p.baseToken?.name ?? '',
    quoteSymbol: p.quoteToken?.symbol ?? '',
    priceUsd: num(p.priceUsd),
    volume24h,
    liquidityUsd: num(p.liquidity?.usd),
    marketCap: num(p.marketCap) ?? num(p.fdv),
    change24h: num(p.priceChange?.h24),
    createdAt: num(p.pairCreatedAt),
    buys24h,
    sells24h,
    flowUsd: estimateFlow(volume24h, buys24h, sells24h),
  };
}

/** Keep pairs whose quote token is `mint`, deduplicated by pair address. */
export function filterByQuote(pairs, mint, chain) {
  const seen = new Set();
  const out = [];
  for (const p of pairs) {
    if (!p || !sameAddress(p.quoteToken?.address, mint, chain)) continue;
    if (chain && p.chainId && p.chainId !== chain) continue;
    if (seen.has(p.pairAddress)) continue;
    seen.add(p.pairAddress);
    out.push(p);
  }
  return out;
}

/**
 * Describe the quote token itself from the pools where it is the base side
 * (for example MOONS/SOL). Picks the most liquid one as its main pool.
 */
export function quoteInfo(pairs, mint, chain) {
  let best = null;
  let symbol = null;
  let name = null;
  for (const p of pairs) {
    if (sameAddress(p?.quoteToken?.address, mint, chain)) {
      symbol ??= p.quoteToken.symbol;
      name ??= p.quoteToken.name;
    }
    if (!p || !sameAddress(p.baseToken?.address, mint, chain)) continue;
    if (chain && p.chainId && p.chainId !== chain) continue;
    if (!best || (num(p.liquidity?.usd) ?? 0) > (num(best.liquidity?.usd) ?? 0)) best = p;
  }
  return {
    address: mint,
    symbol: best?.baseToken?.symbol ?? symbol ?? null,
    name: best?.baseToken?.name ?? name ?? null,
    priceUsd: best ? num(best.priceUsd) : null,
    marketCap: best ? num(best.marketCap) ?? num(best.fdv) : null,
    mainPool: best ? { pairAddress: best.pairAddress, dexId: best.dexId, quoteSymbol: best.quoteToken?.symbol ?? '' } : null,
  };
}

const SORT_FIELDS = {
  volume: 'volume24h',
  flow: 'flowUsd',
  liquidity: 'liquidityUsd',
  mcap: 'marketCap',
  age: 'createdAt',
  change: 'change24h',
};

/** Sort rows descending by key. `age` sorts newest first. Nulls last. */
export function sortRows(rows, key = 'volume') {
  const field = SORT_FIELDS[key];
  if (!field) throw new Error(`Unknown sort key "${key}". Use one of: ${SORT_KEYS.join(', ')}`);
  return [...rows].sort((a, b) => {
    const x = a[field];
    const y = b[field];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return y - x;
  });
}

export function isPump(dexId) {
  return PUMP_DEXES.has(String(dexId || '').toLowerCase());
}

/** Aggregate stats over all matched rows. */
export function summarize(rows) {
  let newest = null;
  let biggest = null;
  let volume24h = 0;
  let liquidityUsd = 0;
  let pump = 0;
  for (const r of rows) {
    volume24h += r.volume24h;
    liquidityUsd += r.liquidityUsd ?? 0;
    if (isPump(r.dexId)) pump++;
    if (r.createdAt != null && (!newest || r.createdAt > newest.createdAt)) newest = r;
    if (!biggest || (r.marketCap ?? -1) > (biggest.marketCap ?? -1)) biggest = r;
  }
  return { totalPairs: rows.length, volume24h, liquidityUsd, newest, biggest, pumpPairs: pump };
}

/** Pairs present in `current` but not in `previousKeys` (a Set of pair addresses). */
export function diffPairs(previousKeys, current) {
  if (!previousKeys) return [];
  return current.filter((r) => !previousKeys.has(r.pairAddress));
}

/** Fetch pools and return matched rows plus quote token info. */
export async function loadPairs(mint, options = {}) {
  if (!mint || typeof mint !== 'string') throw new TypeError('mint address is required');
  const { chain = 'solana', minLiquidity = 0, apiBase = process.env.MOONS_API || DEFAULT_API, ...rest } = options;
  const pools = await fetchTokenPairs(chain, mint, { apiBase, ...rest });
  const rows = filterByQuote(pools, mint, chain)
    .map(toRow)
    .filter((r) => (r.liquidityUsd ?? 0) >= minLiquidity);
  return { rows, quote: quoteInfo(pools, mint, chain), apiBase };
}

/**
 * Scan every pool where `mint` is the quote token.
 * @returns {Promise<{mint, chain, fetchedAt, quote, summary, pairs}>}
 */
export async function scanPairs(mint, options = {}) {
  const { sort = 'volume', limit = 50, chain = 'solana' } = options;
  if (!mint || typeof mint !== 'string') throw new TypeError('scanPairs: mint address is required');
  const { rows, quote } = await loadPairs(mint, { ...options, chain });
  const sorted = sortRows(rows, sort);
  return {
    mint,
    chain,
    fetchedAt: Date.now(),
    quote,
    summary: summarize(rows),
    pairs: limit > 0 ? sorted.slice(0, limit) : sorted,
  };
}
