// Quote token price history from GeckoTerminal OHLCV, using the quote
// token's most liquid pool found through DexScreener.
import { fetchOhlcv } from './client.js';
import { loadPairs } from './core.js';

/**
 * options: chain, timeframe (day|hour|minute), limit, quote (from a report, skips the
 * DexScreener lookup), geckoBase, plus client options.
 */
export async function quotePriceHistory(mint, options = {}) {
  const { chain = 'solana', timeframe = 'hour', limit = 100 } = options;
  const quote = options.quote || (await loadPairs(mint, { ...options, chain })).quote;
  if (!quote?.mainPool) return { mint, chain, pool: null, timeframe, candles: [], change: null };
  const candles = await fetchOhlcv(chain, quote.mainPool.pairAddress, { ...options, timeframe, limit });
  const first = candles[0]?.o;
  const last = candles.at(-1)?.c;
  return {
    mint,
    chain,
    pool: quote.mainPool,
    timeframe,
    candles,
    change: first && last ? (last - first) / first : null,
  };
}
