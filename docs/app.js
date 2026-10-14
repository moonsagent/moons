// moons in the browser: paste a token, get the ecosystem report live from
// DexScreener (pairs) and GeckoTerminal (quote price line). Both APIs allow
// browser calls, so there is no server in between. The analytics are the
// same files the CLI uses, copied into docs/lib (a test keeps them in sync).
import { ecosystemReport } from './lib/ecosystem.js';
import { quotePriceHistory } from './lib/ohlcv.js';
import { renderGraphSvg, renderGraphHtml, GRAPH_SCRIPT, GRAPH_TIP_CSS, esc } from './lib/graph.js';
import { compactUsd, formatAge } from './lib/format.js';
import { DEFAULT_API, DEFAULT_GECKO_API } from './lib/client.js';

export const VERSION = '1.1.0';
export const CHAINS = ['solana', 'base', 'bsc', 'ethereum', 'arbitrum', 'polygon', 'avalanche'];

/** One click examples. USD1 is the quote token of bonk.fun launches, Bert is a memecoin other coins pair against. */
export const EXAMPLES = [
  { label: 'USD1', note: 'bonk.fun quote', chain: 'solana', token: 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB' },
  { label: 'Bert', note: 'memecoin', chain: 'solana', token: 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump' },
  { label: 'USDC', note: 'stablecoin', chain: 'solana', token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
];

// Real Solana addresses are 32 to 44 base58 characters; a little slack keeps the local fixtures valid.
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,50}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Pull a token address out of whatever was pasted: a bare address, or a link
 * from pump.fun, DexScreener, Solscan, Birdeye, Basescan and so on.
 */
export function parseInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (EVM_RE.test(s) || SOLANA_RE.test(s)) return s;
  const parts = s.split(/[\s/?#&=]+/).filter(Boolean).reverse();
  return parts.find((p) => EVM_RE.test(p)) || parts.find((p) => SOLANA_RE.test(p)) || s;
}

/** null when the address fits the chain, otherwise a human message. */
export function validateAddress(addr, chain = 'solana') {
  if (!addr) return 'paste a token address first.';
  if (chain === 'solana') {
    if (EVM_RE.test(addr)) return 'that is an EVM address. pick its chain (base, bsc, ethereum...) in the selector.';
    return SOLANA_RE.test(addr) ? null : 'that does not look like a Solana address (32 to 44 base58 characters, no 0, O, I or l).';
  }
  if (SOLANA_RE.test(addr) && !addr.startsWith('0x')) return `that looks like a Solana address. switch the chain to solana, or paste a ${chain} 0x address.`;
  return EVM_RE.test(addr) ? null : `that does not look like a ${chain} address (0x followed by 40 hex characters).`;
}

/** token and chain from a share link: ?token=...&chain=... (?mint= works too). */
export function readParams(search) {
  const q = new URLSearchParams(search || '');
  const token = parseInput(q.get('token') || q.get('mint') || '');
  const chain = (q.get('chain') || 'solana').toLowerCase();
  return { token, chain: /^[a-z0-9-]{2,24}$/.test(chain) ? chain : 'solana' };
}

/** Share link for a token. Keeps the local test override when present. */
export function shareUrl(loc, token, chain, keep = {}) {
  const q = new URLSearchParams();
  q.set('token', token);
  if (chain && chain !== 'solana') q.set('chain', chain);
  for (const [k, v] of Object.entries(keep)) if (v) q.set(k, v);
  return `${loc.origin}${loc.pathname}?${q}`;
}

/**
 * API base URLs. `?api=http://127.0.0.1:PORT` (or window.__TEST_BASE__) points the page at
 * the local mock API, and only on localhost, so production always talks to the real APIs.
 */
export function apiBases(loc, testBase) {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(loc?.hostname || '');
  const override = local ? testBase || new URLSearchParams(loc.search || '').get('api') : null;
  if (override && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(override.replace(/\/+$/, ''))) {
    const base = override.replace(/\/+$/, '');
    return { apiBase: base, geckoBase: `${base}/gecko`, test: base };
  }
  return { apiBase: DEFAULT_API, geckoBase: DEFAULT_GECKO_API, test: null };
}

/** Browser fetch without custom headers, so DexScreener and GeckoTerminal see a simple CORS request. */
export const browserFetch = (url, init = {}) => globalThis.fetch(url, { method: init.method || 'GET', signal: init.signal });

/** Map any failure to a title and a human message. */
export function errorMessage(err, chain = 'solana') {
  const status = err?.status;
  const msg = String(err?.message || err || '');
  if (status === 429 || /HTTP 429/.test(msg)) {
    return { kind: 'rate', title: 'rate limited', detail: 'DexScreener is asking us to slow down. wait a minute and try again.' };
  }
  if (status >= 500) return { kind: 'api', title: 'DexScreener is having a moment', detail: `it answered with HTTP ${status}. try again in a bit.` };
  if (status === 404 || status === 400) return { kind: 'notfound', title: 'not found', detail: `DexScreener does not know this address on ${chain}.` };
  if (/Network error|Failed to fetch|NetworkError|Load failed|timed? ?out|aborted/i.test(msg)) {
    return { kind: 'network', title: 'could not reach DexScreener', detail: 'check your connection or an ad blocker, then try again.' };
  }
  return { kind: 'error', title: 'something went wrong', detail: msg || 'unknown error' };
}

/** Fetch the report, then the price line. `onReport` fires before the price line arrives. */
export async function runReport(token, chain, { apiBase, geckoBase, fetchImpl = browserFetch, onReport } = {}) {
  const net = { apiBase, geckoBase, fetchImpl, retries: 2, baseDelay: 600, maxRetryAfter: 5000, timeout: 12_000 };
  const report = await ecosystemReport(token, { ...net, chain, minLiquidity: 0, sort: 'volume' });
  onReport?.(report);
  let ohlcv = null;
  if (report.pairs.length && report.quote?.mainPool) {
    try {
      ohlcv = await quotePriceHistory(token, { ...net, chain, quote: report.quote, timeframe: 'hour', limit: 72 });
    } catch (err) {
      ohlcv = { error: err.message, candles: [] };
    }
  }
  return { report, ohlcv };
}

// ---------- rendering (pure: data in, HTML string out) ----------

const usd = compactUsd;
const pct = (x, d = 0) => (x == null || !Number.isFinite(x) ? '-' : `${(x * 100).toFixed(d)}%`);
const chg = (p) => (p == null ? '<span class="mut">-</span>' : `<span class="${p >= 0 ? 'up' : 'down'}">${p > 0 ? '+' : ''}${p.toFixed(1)}%</span>`);
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-6)}` : a || '');

function gauge(h) {
  const R = 128;
  const C = 2 * Math.PI * R;
  const f = Math.max(0, Math.min(1, h.score / 100));
  const a = -Math.PI / 2 + f * 2 * Math.PI;
  const col = h.score >= 70 ? 'var(--up)' : h.score >= 40 ? 'var(--accent)' : 'var(--down)';
  return `<div class="gauge"><svg viewBox="0 0 300 300" aria-hidden="true"><circle cx="150" cy="150" r="146" fill="none" stroke="#8DB8FF" stroke-opacity=".10"/>
<circle cx="150" cy="150" r="${R}" fill="none" stroke="#111A2E" stroke-width="10"/>
<circle cx="150" cy="150" r="${R}" fill="none" stroke="#8DB8FF" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(C * f).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 150 150)"/>
<circle cx="150" cy="150" r="104" fill="#0B1222" stroke="#8DB8FF" stroke-opacity=".12"/>
<circle cx="${(150 + R * Math.cos(a)).toFixed(1)}" cy="${(150 + R * Math.sin(a)).toFixed(1)}" r="9" fill="#E8EEF9" stroke="#060A14" stroke-width="3"/></svg>
<div class="mid"><span class="lbl">pairing health</span><div class="sc">${h.score}<small>/100</small></div><span class="grade" style="color:${col};border-color:${col}">${esc(h.grade)}</span></div></div>`;
}

const stat = (k, v, s, cls = '') => `<div class="st ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;

/** Quote price line from GeckoTerminal candles, or a reserved box while it loads. */
export function renderPrice(o, quote) {
  if (o === undefined) return '<div class="price" data-price><div><div class="k">quote price</div><div class="px"><span class="sk" style="width:110px"></span></div></div><span class="sk spark"></span></div>';
  if (!o || !o.candles || o.candles.length < 2) {
    const px = quote?.priceUsd != null ? usd(quote.priceUsd) : '-';
    return `<div class="price" data-price><div><div class="k">quote price${o?.error ? ', no price line right now' : ''}</div><div class="px">${px}</div></div></div>`;
  }
  const c = o.candles.map((k) => k.c);
  const mn = Math.min(...c);
  const mx = Math.max(...c);
  const w = 240;
  const h = 46;
  const r = mx - mn || 1;
  const d = `M${c.map((v, i) => `${((i / (c.length - 1)) * w).toFixed(1)} ${(h - 3 - ((v - mn) / r) * (h - 6)).toFixed(1)}`).join('L')}`;
  const up = (o.change ?? 0) >= 0;
  const col = up ? '#3DDC84' : '#FF5F6D';
  return `<div class="price" data-price><div><div class="k">quote price, ${o.candles.length}h <span class="${up ? 'up' : 'down'}">${o.change > 0 ? '+' : ''}${pct(o.change, 1)}</span></div><div class="px">${usd(c.at(-1))}</div></div>
<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="quote price, last ${o.candles.length} hours"><defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".25"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
<path d="${d}L${w} ${h}L0 ${h}Z" fill="url(#sg)"/><path d="${d}" fill="none" stroke="${col}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg></div>`;
}

function leaders(r) {
  const t = r.metrics.flowUsd || 1;
  const top = [...r.pairs].sort((a, b) => b.flowUsd - a.flowUsd).slice(0, 6);
  if (!top.length) return '<div class="empty">no flow yet.</div>';
  return `<div class="comp">${top.map((p) => {
    const sh = p.flowUsd / t;
    return `<div class="row"><span>${esc(p.baseSymbol)}<em>${pct(sh)}</em></span><span class="n cy">${usd(p.flowUsd)}</span><div class="bar"><i style="width:${(sh * 100).toFixed(1)}%"></i></div></div>`;
  }).join('')}</div>`;
}

export const COLS = [
  ['baseSymbol', 'Pair'], ['dexId', 'DEX'], ['volume24h', 'Vol 24h'], ['flowUsd', 'Flow est.'], ['liquidityUsd', 'Liquidity'],
  ['marketCap', 'Mcap'], ['change24h', '24h'], ['buys24h', 'Buys / sells'], ['routeShare', 'Via quote'], ['createdAt', 'Age'],
];

/** Sortable table of every pair. */
export function renderTable(r, sort = { key: 'volume24h', dir: -1 }) {
  const now = r.fetchedAt;
  const rows = [...r.pairs].sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string') return x.localeCompare(y) * sort.dir;
    return (x - y) * sort.dir;
  });
  const hasVia = r.pairs.some((p) => p.routeShare != null);
  const cols = COLS.filter((c) => c[0] !== 'routeShare' || hasVia);
  const head = cols.map(([k, t]) => `<th data-k="${k}" class="${sort.key === k ? 'on' : ''}" scope="col"><button type="button">${t}${sort.key === k ? (sort.dir < 0 ? ' &#8595;' : ' &#8593;') : ''}</button></th>`).join('');
  const body = rows.map((p) => {
    const t = p.buys24h + p.sells24h;
    const bw = t ? (p.buys24h / t) * 100 : 0;
    const fresh = p.createdAt != null && now - p.createdAt <= 864e5;
    const cells = {
      baseSymbol: `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.baseSymbol)}</a><span class="mut">/${esc(p.quoteSymbol)}</span>`,
      dexId: `<span class="mut">${esc(p.dexId)}</span>`,
      volume24h: usd(p.volume24h),
      flowUsd: `<span class="cy">${usd(p.flowUsd)}</span>`,
      liquidityUsd: usd(p.liquidityUsd),
      marketCap: usd(p.marketCap),
      change24h: chg(p.change24h),
      buys24h: `<span class="bs">${p.buys24h}/${p.sells24h}<i><u style="width:${bw.toFixed(0)}%"></u></i></span>`,
      routeShare: pct(p.routeShare),
      createdAt: formatAge(p.createdAt, now),
    };
    return `<tr class="${fresh ? 'fresh' : ''}">${cols.map((c) => `<td>${cells[c[0]]}</td>`).join('')}</tr>`;
  }).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Graph size: the CLI canvas on desktop, a taller narrow canvas on phones so labels stay readable. */
export const graphSize = (viewportWidth) => (viewportWidth && viewportWidth < 700 ? { width: 480, height: 600 } : { width: 960, height: 640 });

/** The full report. */
export function renderReport(r, { ohlcv, viewportWidth = 1440, sort } = {}) {
  const m = r.metrics;
  const h = r.health;
  const q = r.quote || {};
  const now = r.fetchedAt;
  const sym = q.symbol || short(r.mint);
  const fresh = r.pairs.filter((p) => p.createdAt != null && now - p.createdAt <= 864e5).sort((a, b) => b.createdAt - a.createdAt);
  const at = new Date(now).toISOString().slice(11, 19);
  const size = graphSize(viewportWidth);
  return `<section class="res-head">
<span class="kicker"><i></i>quote token on ${esc(r.chain)}, live ${at} UTC</span>
<h2 class="sym">${esc(sym)}${q.name && q.name !== sym ? ` <span class="nm">${esc(q.name)}</span>` : ''}</h2>
<div class="qline"><span class="addr" title="${esc(r.mint)}">${esc(short(r.mint))}</span>${q.priceUsd != null ? `<span>price<b>${usd(q.priceUsd)}</b></span><span>mcap<b>${usd(q.marketCap)}</b></span>` : ''}${q.mainPool ? `<span>main pool<b>${esc(q.symbol || '')}/${esc(q.mainPool.quoteSymbol)}</b> <span class="mut">on ${esc(q.mainPool.dexId)}</span></span>` : ''}</div>
<p class="say">${m.totalPairs} pair${m.totalPairs === 1 ? '' : 's'}, ${usd(m.flowUsd)} est. flow back, health ${h.score}/100</p>
<div class="acts"><button type="button" class="ghost" data-act="copy">copy link</button><button type="button" class="ghost" data-act="json">download JSON</button><button type="button" class="ghost" data-act="graph">graph .html</button><a class="ghost" href="https://dexscreener.com/${encodeURIComponent(r.chain)}/${encodeURIComponent(r.mint)}" target="_blank" rel="noopener">DexScreener</a></div>
</section>
<section class="orbit">
<div class="side l">${stat('paired coins', m.totalPairs, `${m.activePairs} active, ${m.pumpPairs} on pump`)}${stat('volume 24h', usd(m.volume24h), `${m.buys24h} buys / ${m.sells24h} sells`)}${stat('liquidity', usd(m.liquidityUsd), `${m.deepPairs} pairs over $10K`)}</div>
${gauge(h)}
<div class="side r">${stat('flow into quote', usd(m.flowUsd), `estimate${r.flowToMcap != null ? `, ${pct(r.flowToMcap, 1)} of mcap` : ''}`, 'acc')}${stat('new pairs', `${m.new24h} / ${m.new7d}`, 'last 24h / last 7d')}${stat('top 3 share', pct(m.top3Share), esc(m.top3.join(', ')) || '-')}</div>
</section>
<p class="nfa">score from public DexScreener data, every formula is below. flow is an estimate. not financial advice.</p>
<section class="panel graph"><div class="ph"><h3>pair network</h3><span class="status"><span class="hint-d">click the graph to zoom, drag to pan, click a coin to open it</span><span class="hint-m">tap a coin to open it on DexScreener</span></span></div><div class="gw" data-graph>${renderGraphSvg(r, { now, ...size })}</div></section>
<div class="duo"><section class="panel"><div class="ph"><h3>health breakdown</h3><span class="status">points per part</span></div><div class="comp">${h.components.map((c) => `<div class="row"><span>${esc(c.label)}<em>${esc(c.detail)}</em></span><span class="n">${c.points}/${c.max}</span><div class="bar"><i style="width:${((c.points / c.max) * 100).toFixed(1)}%"></i></div></div>`).join('')}</div>
<div class="note">score = breadth 20 + flow 25 + diversification 20 + growth 15 + depth 10 + buy pressure 10.${m.routedShare != null ? ` routed via ${esc(sym)}: ${pct(m.routedShare)} of paired coins' total volume.` : ''}${r.enrichError ? ' via quote share skipped: the batch lookup failed.' : ''}</div></section>
<section class="panel"><div class="ph"><h3>flow leaders</h3><span class="status">share of est. flow</span></div>${renderPrice(ohlcv, q)}${leaders(r)}</section></div>
<section class="panel"><div class="ph"><h3>new pairs</h3><span class="status">created in the last 24h</span></div>${fresh.length ? `<div class="chips">${fresh.slice(0, 12).map((p) => `<a class="chip" href="${esc(p.url)}" target="_blank" rel="noopener"><span class="tag">new</span><b>${esc(p.baseSymbol)}</b><span class="m">${formatAge(p.createdAt, now)}, vol ${usd(p.volume24h)}, flow ${usd(p.flowUsd)}</span></a>`).join('')}</div>` : '<div class="empty">no new pairs in the last 24h.</div>'}</section>
<section class="panel"><div class="ph"><h3>all pairs</h3><span class="status">${r.pairs.length} rows, click a header to sort</span></div><div class="tbl" data-table>${renderTable(r, sort)}</div></section>`;
}

/** Loading skeleton with the same blocks as the report, so nothing jumps when data lands. */
export function renderSkeleton(token, chain) {
  const st = '<div class="st"><div class="k"><span class="sk" style="width:80px"></span></div><div class="v"><span class="sk" style="width:110px;height:26px"></span></div><div class="s"><span class="sk" style="width:130px"></span></div></div>';
  return `<div class="loading" role="status" aria-live="polite"><section class="res-head">
<span class="kicker"><i class="pulse"></i>reading ${esc(chain)} pools from DexScreener</span>
<h2 class="sym"><span class="sk" style="width:180px;height:44px"></span></h2>
<div class="qline"><span class="addr">${esc(short(token))}</span><span class="sk" style="width:260px"></span></div><p class="say"><span class="sk" style="width:260px"></span></p><div class="acts"><span class="sk" style="width:360px;height:34px"></span></div></section>
<section class="orbit"><div class="side l">${st}${st}${st}</div><div class="gauge"><svg viewBox="0 0 300 300" aria-hidden="true"><circle cx="150" cy="150" r="128" fill="none" stroke="#111A2E" stroke-width="10"/><circle class="spin" cx="150" cy="150" r="128" fill="none" stroke="#8DB8FF" stroke-width="10" stroke-linecap="round" stroke-dasharray="120 804"/><circle cx="150" cy="150" r="104" fill="#0B1222" stroke="#8DB8FF" stroke-opacity=".12"/></svg><div class="mid"><span class="lbl">pairing health</span><div class="sc mut">..</div></div></div><div class="side r">${st}${st}${st}</div></section>
<p class="nfa">&nbsp;</p>
<section class="panel graph"><div class="ph"><h3>pair network</h3></div><div class="gw gsk"></div></section></div>`;
}

/** Errors and empty results, each with a way forward. */
export function renderMessage({ title, detail, kind = 'error', token = '', examples = true }) {
  const tone = kind === 'empty' ? '' : ' bad';
  return `<section class="msg${tone}" data-kind="${esc(kind)}" role="alert"><div class="msg-orb" aria-hidden="true"><svg viewBox="0 0 120 60"><ellipse cx="60" cy="30" rx="56" ry="22" fill="none" stroke="#8DB8FF" stroke-opacity=".25"/><circle cx="60" cy="30" r="11" fill="${kind === 'empty' ? '#8DB8FF' : '#FF5F6D'}" fill-opacity=".85"/><circle cx="104" cy="24" r="3" fill="#8DB8FF" fill-opacity=".6"/></svg></div>
<h2>${esc(title)}</h2><p>${detail}</p>${token ? `<p class="addr">${esc(token)}</p>` : ''}${examples ? `<p class="mut small">or try ${EXAMPLES.map((e) => `<a href="?token=${e.token}" data-example="${e.token}" data-chain="${e.chain}">${esc(e.label)}</a>`).join(', ')}.</p>` : ''}</section>`;
}

/** Message for a token that has pools but is never the quote side. */
export function emptyMessage(r) {
  const sym = r.quote?.symbol || short(r.mint);
  return {
    kind: 'empty',
    title: `no coins trade against ${sym} yet`,
    detail: `${esc(sym)} is live on DexScreener, but in the pools it returns ${esc(sym)} is always the base side, never the quote. DexScreener returns up to 30 pools per token, most liquid first, so a very large token can hide its smaller quote-side pairs. launchpad quote tokens and coins other coins pair against show up best.`,
    token: r.mint,
  };
}

// ---------- the page ----------

/* c8 ignore start */
function boot() {
  const $ = (s) => document.querySelector(s);
  const form = $('#scan');
  const input = $('#token');
  const select = $('#chain');
  const app = $('#app');
  const bases = apiBases(location, window.__TEST_BASE__);
  const S = { token: '', chain: 'solana', report: null, ohlcv: undefined, sort: { key: 'volume24h', dir: -1 }, run: 0 };

  const style = document.createElement('style');
  style.textContent = GRAPH_TIP_CSS;
  document.head.appendChild(style);
  const gs = document.createElement('script');
  gs.textContent = GRAPH_SCRIPT;
  document.body.appendChild(gs);

  for (const c of CHAINS) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    select.appendChild(o);
  }

  const setChain = (c) => {
    if (![...select.options].some((o) => o.value === c)) {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      select.appendChild(o);
    }
    select.value = c;
  };

  const keep = () => (bases.test ? { api: bases.test } : {});

  function wireGraph() {
    const host = app.querySelector('[data-graph]');
    if (!host) return;
    window.moonsGraph?.(host);
    // The wheel scrolls the page until the graph is clicked, then it zooms.
    host.addEventListener('wheel', (e) => { if (!host.classList.contains('live')) e.stopPropagation(); }, { capture: true });
    host.addEventListener('mousedown', () => host.classList.add('live'));
    host.addEventListener('mouseleave', () => host.classList.remove('live'));
  }

  function draw() {
    app.innerHTML = renderReport(S.report, { ohlcv: S.ohlcv, viewportWidth: window.innerWidth, sort: S.sort });
    wireGraph();
  }

  // Bring the report up so the health ring is on screen, unless the visitor already scrolled past it.
  function reveal() {
    const top = app.getBoundingClientRect().top;
    if (top > 80 && top > window.innerHeight * 0.3) window.scrollTo({ top: window.scrollY + top - 12, behavior: 'smooth' });
  }

  function download(name, type, text) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function go(token, chain, { push = true } = {}) {
    token = parseInput(token);
    input.value = token;
    setChain(chain);
    const bad = validateAddress(token, chain);
    if (bad) {
      app.innerHTML = renderMessage({ kind: 'bad', title: 'check the address', detail: esc(bad), token });
      return;
    }
    S.token = token;
    S.chain = chain;
    S.report = null;
    S.ohlcv = undefined;
    const run = ++S.run;
    if (push) {
      try { history.pushState(null, '', shareUrl(location, token, chain, keep())); } catch { /* file:// or sandboxed */ }
    }
    document.title = 'moons: every coin that trades against yours';
    app.innerHTML = renderSkeleton(token, chain);
    form.querySelector('button[type=submit]').disabled = true;
    try {
      const { report, ohlcv } = await runReport(token, chain, {
        ...bases,
        onReport: (r) => {
          if (run !== S.run) return;
          S.report = r;
          if (!r.pairs.length) {
            app.innerHTML = r.quote?.symbol
              ? renderMessage(emptyMessage(r))
              : renderMessage({ kind: 'notfound', title: 'not found', detail: `DexScreener has no pools for this address on ${esc(chain)}. check the chain, or the coin may not have traded yet.`, token });
            return;
          }
          document.title = `${r.quote?.symbol || 'token'} moons: ${r.metrics.totalPairs} pairs, health ${r.health.score}/100`;
          draw();
          reveal();
        },
      });
      if (run !== S.run || !report.pairs.length) return;
      S.ohlcv = ohlcv;
      const box = app.querySelector('[data-price]');
      if (box) box.outerHTML = renderPrice(ohlcv, report.quote);
    } catch (err) {
      if (run !== S.run) return;
      const e = errorMessage(err, chain);
      app.innerHTML = renderMessage({ ...e, detail: esc(e.detail), token });
    } finally {
      if (run === S.run) form.querySelector('button[type=submit]').disabled = false;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go(input.value, select.value);
  });
  input.addEventListener('paste', () => setTimeout(() => {
    const t = parseInput(input.value);
    if (t.startsWith('0x') && select.value === 'solana') return; // let the visitor pick the EVM chain
    if (t !== input.value) input.value = t;
  }, 0));

  document.addEventListener('click', (e) => {
    const ex = e.target.closest?.('[data-example]');
    if (ex) {
      e.preventDefault();
      go(ex.dataset.example, ex.dataset.chain || 'solana');
      $('#tool')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const th = e.target.closest?.('th[data-k]');
    if (th && S.report) {
      const k = th.dataset.k;
      S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: k === 'baseSymbol' || k === 'dexId' ? 1 : -1 };
      app.querySelector('[data-table]').innerHTML = renderTable(S.report, S.sort);
      return;
    }
    const act = e.target.closest?.('[data-act]');
    if (act && S.report) {
      const name = `${(S.report.quote?.symbol || 'token').replace(/[^\w-]+/g, '')}-moons`;
      if (act.dataset.act === 'copy') {
        const url = shareUrl(location, S.token, S.chain);
        const done = () => { act.textContent = 'link copied'; setTimeout(() => { act.textContent = 'copy link'; }, 1500); };
        navigator.clipboard ? navigator.clipboard.writeText(url).then(done, done) : done();
      }
      if (act.dataset.act === 'json') download(`${name}.json`, 'application/json', JSON.stringify({ ...S.report, ohlcv: S.ohlcv || null }, null, 2));
      if (act.dataset.act === 'graph') download(`${name}.html`, 'text/html', renderGraphHtml(S.report));
    }
    const cp = e.target.closest?.('button.copy[data-copy]');
    if (cp) {
      const done = () => { cp.textContent = 'Copied'; setTimeout(() => { cp.textContent = 'Copy'; }, 1500); };
      navigator.clipboard ? navigator.clipboard.writeText(cp.dataset.copy).then(done, done) : done();
    }
  });

  let wide = window.innerWidth >= 700;
  window.addEventListener('resize', () => {
    const now = window.innerWidth >= 700;
    if (now !== wide && S.report?.pairs.length) draw();
    wide = now;
  });

  window.addEventListener('popstate', () => {
    const p = readParams(location.search);
    if (p.token) go(p.token, p.chain, { push: false });
  });

  const p = readParams(location.search);
  setChain(p.chain);
  if (p.token) go(p.token, p.chain, { push: false });
  window.__moons = { go, state: S };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
/* c8 ignore stop */
