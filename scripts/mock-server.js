// Local stand-in for DexScreener, GeckoTerminal, a webhook and the Telegram
// Bot API, used by tests and for offline demos.
// Usage: node scripts/mock-server.js [port]
// Then:  MOONS_API=http://127.0.0.1:8787 MOONS_GECKO_API=http://127.0.0.1:8787/gecko \
//        moons MoonsQuoteMint1111111111111111111111111pump
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8'));
export const FIXTURE_MINT = 'MoonsQuoteMint1111111111111111111111111pump';
export const PAD_MINT = 'PadQuoteMint22222222222222222222222222222pump';
export const HUB_MINT = 'HubQuoteMint333333333333333333333333333333pump';
export const MOONS_MAIN_POOL = 'PairSOL1111111111111111111111111111111111111';
// OHLCV fixture is MOONS/SOL; other main pools reuse it scaled to their price.
const OHLCV_SCALE = { [MOONS_MAIN_POOL]: 1, PairHubSOL1111111111111111111111111111111111: 0.0236 / 0.0101 };
export const FIXTURE_TIME = Date.parse('2026-10-14T12:00:00Z');

export function loadFixture() {
  return fixture('token-pairs.json');
}
export const loadPadFixture = () => fixture('token-pairs-pad.json');

/**
 * Start a mock server.
 * options.responses: array of pair arrays for FIXTURE_MINT on successive calls (last one repeats)
 * options.failures: number of initial requests answered with options.failStatus (default 429)
 * options.retryAfter: Retry-After header value sent with failures
 * options.rebase: shift pairCreatedAt so ages are relative to the current time
 * state.posts collects POST bodies sent to /webhook and /telegram.
 */
export function startMockServer(options = {}) {
  const { failures = 0, failStatus = 429, rebase = false, retryAfter } = options;
  const responses = options.responses || [loadFixture()];
  const pad = loadPadFixture();
  const hub = fixture('token-pairs-demo.json');
  const extra = fixture('tokens.json');
  const ohlcv = fixture('ohlcv.json');
  const state = { requests: [], calls: 0, posts: [] };
  const shift = rebase ? Date.now() - FIXTURE_TIME : 0;
  const shiftPairs = (list) => (shift ? list.map((p) => ({ ...p, pairCreatedAt: p.pairCreatedAt + shift })) : list);
  const send = (res, status, body, headers = {}) => {
    // CORS like the real DexScreener and GeckoTerminal APIs, so the website can call the mock from the browser.
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'retry-after', ...headers });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST' });
      return res.end();
    }
    state.requests.push(req.url);
    if (state.requests.length <= failures) {
      return send(res, failStatus, { error: 'rate limited' }, retryAfter != null ? { 'retry-after': String(retryAfter) } : {});
    }
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* keep null */ }
        state.posts.push({ url: req.url, body });
        if (/^\/(webhook|telegram\/bot[^/]+\/sendMessage)/.test(req.url)) return send(res, 200, { ok: true });
        send(res, 404, { error: 'not found' });
      });
      return;
    }
    const url = new URL(req.url, 'http://x');
    let m = url.pathname.match(/^\/token-pairs\/v1\/([^/]+)\/([^/]+)$/);
    if (m) {
      const mint = decodeURIComponent(m[2]);
      let body = [];
      if (mint === FIXTURE_MINT) {
        body = responses[Math.min(state.calls, responses.length - 1)];
        state.calls++;
      } else if (mint === PAD_MINT) body = pad;
      else if (mint === HUB_MINT) body = hub;
      return send(res, 200, shiftPairs(body));
    }
    m = url.pathname.match(/^\/tokens\/v1\/([^/]+)\/([^/]+)$/);
    if (m) {
      const wanted = new Set(decodeURIComponent(m[2]).split(','));
      if (wanted.size > 30) return send(res, 400, { error: 'max 30 addresses' });
      const all = [...loadFixture(), ...pad, ...hub, ...extra];
      const seen = new Set();
      const body = all.filter((p) => {
        const hit = (wanted.has(p.baseToken.address) || wanted.has(p.quoteToken.address)) && !seen.has(p.pairAddress);
        if (hit) seen.add(p.pairAddress);
        return hit;
      });
      return send(res, 200, shiftPairs(body));
    }
    m = url.pathname.match(/^\/gecko\/networks\/([^/]+)\/pools\/([^/]+)\/ohlcv\/(day|hour|minute)$/);
    if (m) {
      const scale = OHLCV_SCALE[decodeURIComponent(m[2])];
      if (!scale) return send(res, 404, { errors: [{ status: '404', title: 'Not Found' }] });
      const list = ohlcv.data.attributes.ohlcv_list.map(([t, ...rest]) => [
        t + Math.round(shift / 1000),
        ...rest.map((v, i) => (i < 4 ? String(+(Number(v) * scale).toPrecision(6)) : v)),
      ]);
      return send(res, 200, { ...ohlcv, data: { ...ohlcv.data, attributes: { ohlcv_list: list } } });
    }
    send(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(options.port || 0, '127.0.0.1', () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}`;
      resolve({
        url,
        gecko: `${url}/gecko`,
        telegram: `${url}/telegram`,
        webhook: `${url}/webhook`,
        state,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const srv = await startMockServer({ port: Number(process.argv[2]) || 8787, rebase: true });
  console.log(`mock APIs on ${srv.url} (DexScreener), ${srv.gecko} (GeckoTerminal), ${srv.webhook}, ${srv.telegram}`);
}
