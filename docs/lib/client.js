// HTTP layer: DexScreener and GeckoTerminal clients with retry, backoff,
// Retry-After support, a short in-memory cache and a GeckoTerminal rate limiter.

export const DEFAULT_API = 'https://api.dexscreener.com';
export const DEFAULT_GECKO_API = 'https://api.geckoterminal.com/api/v2';
export const DEFAULT_CACHE_TTL = 15_000;
export const BATCH_SIZE = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trimBase = (u) => String(u).replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Parse Retry-After as seconds or an HTTP date. Returns milliseconds or null. */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs >= 0 ? secs * 1000 : null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

const cache = new Map();
export function clearCache() {
  cache.clear();
}

/**
 * Send a request and parse JSON. Retries 429, 5xx and network errors with
 * exponential backoff, honours Retry-After (capped by maxRetryAfter).
 * GET responses are cached in memory for `cacheTtl` ms when cacheTtl > 0.
 */
export async function requestJson(url, opts = {}) {
  const {
    method = 'GET',
    body,
    retries = 4,
    baseDelay = 500,
    maxRetryAfter = 60_000,
    fetchImpl = globalThis.fetch,
    timeout = 15_000,
    cacheTtl = 0,
  } = opts;
  const cacheable = method === 'GET' && cacheTtl > 0;
  if (cacheable) {
    const hit = cache.get(url);
    if (hit && hit.expires > Date.now()) return hit.data;
  }
  const headers = { accept: 'application/json', 'user-agent': 'moons' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      lastErr = new ApiError(`Network error requesting ${redact(url)}: ${err.message}`);
      if (attempt < retries) {
        await sleep(baseDelay * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
    if (res.ok) {
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new ApiError(`Invalid JSON from ${redact(url)}`, res.status);
        }
      }
      if (cacheable) cache.set(url, { data, expires: Date.now() + cacheTtl });
      return data;
    }
    const retryable = res.status === 429 || res.status >= 500;
    lastErr = new ApiError(`HTTP ${res.status} from ${redact(url)}`, res.status);
    if (!retryable || attempt === retries) throw lastErr;
    const ra = retryAfterMs(res.headers.get('retry-after'));
    await sleep(ra != null ? Math.min(ra, maxRetryAfter) : baseDelay * 2 ** attempt);
  }
  throw lastErr;
}

/** Backwards compatible alias from 0.1.0. */
export const getJson = (url, opts) => requestJson(url, opts);

/** Hide bot tokens in error messages. */
export function redact(url) {
  return String(url).replace(/\/bot[^/]+\//, '/bot<redacted>/');
}

/** Pools for one token: GET /token-pairs/v1/{chainId}/{tokenAddress} */
export async function fetchTokenPairs(chain, address, opts = {}) {
  const base = trimBase(opts.apiBase || DEFAULT_API);
  const url = `${base}/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`;
  const data = await requestJson(url, { cacheTtl: DEFAULT_CACHE_TTL, ...opts });
  return Array.isArray(data) ? data : [];
}

/** Pools for many tokens: GET /tokens/v1/{chainId}/{addr1,addr2,...}, chunked by 30. */
export async function fetchTokensBatch(chain, addresses, opts = {}) {
  const base = trimBase(opts.apiBase || DEFAULT_API);
  const unique = [...new Set(addresses.filter(Boolean))];
  const out = [];
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE).map(encodeURIComponent).join(',');
    const data = await requestJson(`${base}/tokens/v1/${encodeURIComponent(chain)}/${chunk}`, {
      cacheTtl: DEFAULT_CACHE_TTL,
      ...opts,
    });
    if (Array.isArray(data)) out.push(...data);
  }
  return out;
}

/** DexScreener chain id to GeckoTerminal network id. */
const GECKO_NETWORKS = { ethereum: 'eth', bsc: 'bsc', polygon: 'polygon_pos', avalanche: 'avax' };
export const geckoNetwork = (chain) => GECKO_NETWORKS[chain] || chain;

/** Sliding window limiter: at most `max` calls per `windowMs`. */
export function createLimiter(max = 30, windowMs = 60_000) {
  const stamps = [];
  return async function acquire() {
    for (;;) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length < max) {
        stamps.push(now);
        return;
      }
      await sleep(windowMs - (now - stamps[0]) + 5);
    }
  };
}
const geckoLimit = createLimiter(30, 60_000);

/**
 * OHLCV candles for one pool from GeckoTerminal:
 * GET /networks/{network}/pools/{pool}/ohlcv/{day|hour|minute}?aggregate=1&limit=100
 * Returns [{t, o, h, l, c, v}] sorted oldest first, t in ms.
 */
export async function fetchOhlcv(chain, pool, opts = {}) {
  const { timeframe = 'hour', limit = 100 } = opts;
  if (!['day', 'hour', 'minute'].includes(timeframe)) throw new TypeError(`timeframe must be day, hour or minute`);
  const base = trimBase(opts.geckoBase || process.env.MOONS_GECKO_API || DEFAULT_GECKO_API);
  const url = `${base}/networks/${encodeURIComponent(geckoNetwork(chain))}/pools/${encodeURIComponent(pool)}/ohlcv/${timeframe}?aggregate=1&limit=${limit}`;
  await (opts.limiter || geckoLimit)();
  const data = await requestJson(url, { cacheTtl: 60_000, ...opts });
  const list = data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  return list
    .map(([t, o, h, l, c, v]) => ({ t: t * 1000, o: +o, h: +h, l: +l, c: +c, v: +v }))
    .sort((a, b) => a.t - b.t);
}

/** POST JSON (webhooks, Telegram). Fewer retries than reads. */
export function postJson(url, body, opts = {}) {
  return requestJson(url, { retries: 2, ...opts, method: 'POST', body, cacheTtl: 0 });
}
