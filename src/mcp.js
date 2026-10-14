// Model Context Protocol server over stdio: JSON-RPC 2.0, one JSON message per line.
import { createInterface } from 'node:readline';
import { scanPairs, SORT_KEYS } from './core.js';
import { ecosystemReport, compareTokens, newPairsSince } from './ecosystem.js';

export const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST = '2025-06-18';

const mintProp = { type: 'string', description: 'Quote token address (Solana mint or EVM contract).' };
const chainProp = { type: 'string', description: 'DexScreener chain id, for example solana, base, bsc, ethereum.', default: 'solana' };

export const TOOLS = [
  {
    name: 'scan_pairs',
    description: 'List DEX pools where the given token is the quote token, with 24h volume, estimated flow into the quote, liquidity, market cap, buys/sells, 24h change and age. Data from DexScreener.',
    inputSchema: {
      type: 'object',
      properties: {
        mint: mintProp,
        chain: chainProp,
        sort: { type: 'string', enum: SORT_KEYS, default: 'volume' },
        min_liquidity: { type: 'number', minimum: 0, default: 0, description: 'Hide pools with less USD liquidity.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
      },
      required: ['mint'],
      additionalProperties: false,
    },
  },
  {
    name: 'ecosystem_report',
    description: 'Ecosystem report for a quote token: estimated 24h flow into the quote (buy-side volume of its pairs), concentration (top 3 share), growth (new pairs in 24h and 7d), share of paired coins volume routed through the quote, and a 0 to 100 pairing health score with its components.',
    inputSchema: {
      type: 'object',
      properties: {
        mint: mintProp,
        chain: chainProp,
        min_liquidity: { type: 'number', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 15, description: 'Number of top pairs to include (metrics always use all pairs).' },
      },
      required: ['mint'],
      additionalProperties: false,
    },
  },
  {
    name: 'compare_tokens',
    description: 'Compare the paired-coin ecosystems of 2 to 5 quote tokens side by side: health, pairs, volume, estimated flow, liquidity, new pairs, concentration and buy ratio.',
    inputSchema: {
      type: 'object',
      properties: {
        mints: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
        chain: chainProp,
      },
      required: ['mints'],
      additionalProperties: false,
    },
  },
  {
    name: 'new_pairs_since',
    description: 'Pairs quoted in the token that were created at or after a point in time. `since` accepts a duration (90m, 24h, 7d), an ISO date or a unix timestamp.',
    inputSchema: {
      type: 'object',
      properties: { mint: mintProp, since: { type: 'string', default: '24h' }, chain: chainProp },
      required: ['mint'],
      additionalProperties: false,
    },
  },
];

const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const compactPair = (p) => ({
  pair: `${p.baseSymbol}/${p.quoteSymbol}`,
  dex: p.dexId,
  pairAddress: p.pairAddress,
  baseAddress: p.baseAddress,
  volume24h: r2(p.volume24h),
  flowUsdEst: r2(p.flowUsd),
  liquidityUsd: r2(p.liquidityUsd),
  marketCap: r2(p.marketCap),
  change24h: p.change24h,
  buys24h: p.buys24h,
  sells24h: p.sells24h,
  routeShare: p.routeShare == null ? undefined : r2(p.routeShare),
  createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
  url: p.url,
});
const metricsOut = (m) => ({ ...m, newest: m.newest ? compactPair(m.newest) : null, biggest: m.biggest ? compactPair(m.biggest) : null });

class InvalidParams extends Error {}

function need(args, key, type) {
  const v = args[key];
  if (type === 'array' ? !Array.isArray(v) : typeof v !== type || (type === 'string' && !v.trim())) {
    throw new InvalidParams(`"${key}" is required and must be a ${type === 'array' ? 'non-empty array' : `non-empty ${type}`}`);
  }
  return v;
}

/** Execute one tool. Throws InvalidParams for bad input, other errors become isError results. */
export async function callTool(name, args = {}, base = {}) {
  const chain = typeof args.chain === 'string' && args.chain ? args.chain.toLowerCase() : 'solana';
  const opts = { ...base, chain };
  switch (name) {
    case 'scan_pairs': {
      const mint = need(args, 'mint', 'string');
      if (args.sort && !SORT_KEYS.includes(args.sort)) throw new InvalidParams(`sort must be one of ${SORT_KEYS.join(', ')}`);
      const r = await scanPairs(mint, { ...opts, sort: args.sort || 'volume', minLiquidity: Number(args.min_liquidity) || 0, limit: Math.min(200, Number(args.limit) || 25) });
      const s = r.summary;
      return { mint, chain, quote: r.quote, totalPairs: s.totalPairs, volume24h: r2(s.volume24h), liquidityUsd: r2(s.liquidityUsd), pairs: r.pairs.map(compactPair) };
    }
    case 'ecosystem_report': {
      const mint = need(args, 'mint', 'string');
      const r = await ecosystemReport(mint, { ...opts, minLiquidity: Number(args.min_liquidity) || 0 });
      return {
        mint,
        chain,
        quote: r.quote,
        health: r.health,
        metrics: metricsOut(r.metrics),
        flowToQuoteMcap: r.flowToMcap,
        flowNote: 'flowUsd is an estimate: sum over pairs of volume.h24 * buys / (buys + sells).',
        topPairs: r.pairs.slice(0, Math.min(200, Number(args.limit) || 15)).map(compactPair),
      };
    }
    case 'compare_tokens': {
      const mints = need(args, 'mints', 'array');
      if (mints.length < 2 || mints.length > 5 || !mints.every((m) => typeof m === 'string' && m)) throw new InvalidParams('"mints" must hold 2 to 5 addresses');
      const c = await compareTokens(mints, opts);
      return {
        chain,
        tokens: c.reports.map((r, i) => ({ label: c.labels[i], mint: r.mint })),
        metrics: c.metrics.map((m) => ({ metric: m.key, label: m.label, values: m.values.map(r2), leader: m.leader == null || m.leader < 0 ? null : c.labels[m.leader] })),
      };
    }
    case 'new_pairs_since': {
      const mint = need(args, 'mint', 'string');
      let r;
      try {
        r = await newPairsSince(mint, args.since ?? '24h', opts);
      } catch (err) {
        if (err instanceof TypeError) throw new InvalidParams(err.message);
        throw err;
      }
      return { ...r, pairs: r.pairs.map(compactPair) };
    }
    default:
      throw new InvalidParams(`Unknown tool "${name}"`);
  }
}

/** Handle one parsed JSON-RPC message. Returns a response object or null for notifications. */
export async function handleMessage(msg, ctx) {
  const isRequest = msg && typeof msg === 'object' && 'id' in msg && msg.id !== null;
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: isRequest ? msg.id : null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
  if (!isRequest) return null; // notifications, including notifications/initialized
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST,
        capabilities: { tools: {} },
        serverInfo: { name: 'moons', version: ctx.version },
        instructions: 'Map coins that trade against a quote token. Flow figures are estimates from buy-side volume.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params || {};
      if (typeof name !== 'string') return fail(-32602, 'params.name is required');
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool "${name}"`);
      if (typeof args !== 'object' || args === null || Array.isArray(args)) return fail(-32602, 'params.arguments must be an object');
      try {
        const data = await callTool(name, args, ctx.options);
        return reply({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (err) {
        if (err instanceof InvalidParams) return fail(-32602, err.message);
        return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** Run the stdio server until stdin closes. Logs go to stderr only. */
export function runMcpServer({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, version = '0.0.0', options = {} } = {}) {
  const ctx = { version, options };
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  const pending = new Set();
  stderr.write(`moons MCP server ${version} ready on stdio\n`);
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    const p = handleMessage(msg, ctx)
      .then((res) => { if (res) stdout.write(`${JSON.stringify(res)}\n`); })
      .catch((err) => stderr.write(`moons mcp: ${err.stack || err}\n`))
      .finally(() => pending.delete(p));
    pending.add(p);
  });
  return new Promise((resolve) => rl.on('close', () => Promise.allSettled([...pending]).then(() => resolve(0))));
}
