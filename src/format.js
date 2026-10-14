// Output formatting: compact numbers, ages, aligned tables, CSV.

export function compactUsd(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [v, s] of units) {
    if (abs >= v) {
      const x = abs / v;
      return `${sign}$${x >= 100 ? Math.round(x) : trim(x.toFixed(1))}${s}`;
    }
  }
  if (abs >= 1) return `${sign}$${trim(abs.toFixed(abs >= 100 ? 0 : 2))}`;
  if (abs === 0) return '$0';
  return `${sign}$${abs.toPrecision(2)}`;
}

const trim = (s) => s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');

export function formatAge(createdAt, now = Date.now()) {
  if (createdAt == null) return '-';
  const s = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

export function formatChange(pct) {
  if (pct == null) return '-';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export function truncate(str, max) {
  const s = String(str ?? '');
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function useColor(stream = process.stdout, env = process.env) {
  return Boolean(stream.isTTY) && !('NO_COLOR' in env) && env.TERM !== 'dumb';
}

const paint = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
export const green = paint('32');
export const red = paint('31');
export const dim = paint('2');
export const bold = paint('1');
export const yellow = paint('33');

export const cyan = paint('36');

const COLUMNS = [
  { key: 'mark', title: '', align: 'left' },
  { key: 'base', title: 'PAIR', align: 'left', max: 22 },
  { key: 'dex', title: 'DEX', align: 'left', max: 12 },
  { key: 'price', title: 'PRICE', align: 'right' },
  { key: 'vol', title: 'VOL 24H', align: 'right' },
  { key: 'flow', title: 'FLOW EST', align: 'right' },
  { key: 'liq', title: 'LIQUIDITY', align: 'right' },
  { key: 'mcap', title: 'MCAP', align: 'right' },
  { key: 'chg', title: 'CHG 24H', align: 'right' },
  { key: 'bs', title: 'BUYS/SELLS', align: 'right' },
  { key: 'via', title: 'VIA QUOTE', align: 'right' },
  { key: 'age', title: 'AGE', align: 'right' },
];

const pct = (x, d = 0) => (x == null ? '-' : `${(x * 100).toFixed(d)}%`);

/** Render rows as an aligned text table. `newKeys` marks fresh pairs. */
export function renderTable(rows, { color = false, now = Date.now(), newKeys } = {}) {
  if (!rows.length) return 'No pairs found where this token is the quote token.';
  const cells = rows.map((r) => ({
    mark: newKeys?.has(r.pairAddress) ? 'NEW' : '',
    base: truncate(`${r.baseSymbol}/${r.quoteSymbol}`, 22),
    dex: truncate(r.dexId, 12),
    price: compactUsd(r.priceUsd),
    vol: compactUsd(r.volume24h),
    flow: compactUsd(r.flowUsd ?? null),
    liq: compactUsd(r.liquidityUsd),
    mcap: compactUsd(r.marketCap),
    chg: formatChange(r.change24h),
    bs: `${r.buys24h}/${r.sells24h}`,
    via: pct(r.routeShare),
    age: formatAge(r.createdAt, now),
    _chg: r.change24h,
  }));
  const cols = COLUMNS.filter(
    (c) => (c.key !== 'mark' || cells.some((x) => x.mark)) && (c.key !== 'via' || rows.some((r) => r.routeShare != null)),
  );
  const widths = cols.map((c) => Math.max(c.title.length, ...cells.map((x) => x[c.key].length)));
  const pad = (s, w, align) => (align === 'right' ? s.padStart(w) : s.padEnd(w));
  const header = cols.map((c, i) => pad(c.title, widths[i], c.align)).join('  ').trimEnd();
  const lines = [color ? bold(header) : header];
  for (const x of cells) {
    const parts = cols.map((c, i) => {
      let s = pad(x[c.key], widths[i], c.align);
      if (color && c.key === 'chg' && x._chg != null) s = x._chg >= 0 ? green(s) : red(s);
      if (color && c.key === 'mark' && x.mark) s = yellow(s);
      if (color && c.key === 'flow') s = cyan(s);
      return s;
    });
    lines.push(parts.join('  ').trimEnd());
  }
  return lines.join('\n');
}

export function renderSummary(result, { color = false, now = Date.now() } = {}) {
  const { summary: s, mint, chain } = result;
  const label = (t) => (color ? dim(t) : t);
  const row = (k, v) => `${label(k.padEnd(16))}${v}`;
  const desc = (r) =>
    r ? `${r.baseSymbol} on ${r.dexId} (${r.pairAddress})` : '-';
  return [
    row('Quote token', `${mint} (${chain})`),
    row('Pairs', String(s.totalPairs)),
    row('Volume 24h', compactUsd(s.volume24h)),
    row('Liquidity', compactUsd(s.liquidityUsd)),
    row('Newest pair', s.newest ? `${desc(s.newest)}, ${formatAge(s.newest.createdAt, now)} old` : '-'),
    row('Biggest pair', s.biggest ? `${desc(s.biggest)}, mcap ${compactUsd(s.biggest.marketCap)}` : '-'),
    row('On pump.fun', `${s.pumpPairs} of ${s.totalPairs} (pumpfun/pumpswap)`),
  ].join('\n');
}

const CSV_FIELDS = [
  'pairAddress', 'chainId', 'dexId', 'baseAddress', 'baseSymbol', 'baseName', 'quoteSymbol',
  'priceUsd', 'volume24h', 'liquidityUsd', 'marketCap', 'change24h', 'buys24h', 'sells24h',
  'createdAt', 'flowUsd', 'routeShare', 'url',
];

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(rows) {
  const lines = [CSV_FIELDS.join(',')];
  for (const r of rows) lines.push(CSV_FIELDS.map((f) => csvCell(r[f])).join(','));
  return lines.join('\n');
}

/** Text bar like [#######.....] for a 0..1 ratio. */
export function bar(ratio, width = 12) {
  const n = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return `${'#'.repeat(n)}${'.'.repeat(width - n)}`;
}

/** Summary block for an ecosystem report. */
export function renderReportSummary(report, { color = false, now = report.fetchedAt } = {}) {
  const { metrics: m, health: h, quote: q } = report;
  const label = (t) => (color ? dim(t) : t);
  const row = (k, v) => `${label(k.padEnd(18))}${v}`;
  const qname = q?.symbol ? `${q.symbol} ` : '';
  const grade = color ? (h.score >= 70 ? green : h.score >= 40 ? yellow : red)(`${h.score}/100 ${h.grade}`) : `${h.score}/100 ${h.grade}`;
  const lines = [
    row('Quote token', `${qname}${report.mint} (${report.chain})`),
  ];
  if (q?.priceUsd != null) lines.push(row('Quote price', `${compactUsd(q.priceUsd)}, mcap ${compactUsd(q.marketCap)}`));
  lines.push(
    row('Pairs', `${m.totalPairs} (${m.activePairs} active, ${m.pumpPairs} on pump.fun/PumpSwap)`),
    row('Volume 24h', compactUsd(m.volume24h)),
    row('Flow into quote', `${color ? cyan(compactUsd(m.flowUsd)) : compactUsd(m.flowUsd)} est. (buy-side volume)${report.flowToMcap != null ? `, ${pct(report.flowToMcap, 1)} of quote mcap` : ''}`),
    row('Liquidity', compactUsd(m.liquidityUsd)),
    row('Buys / sells', `${m.buys24h} / ${m.sells24h} (${pct(m.buyRatio)} buys)`),
    row('Concentration', `top 3 = ${pct(m.top3Share)} of volume${m.top3.length ? ` (${m.top3.join(', ')})` : ''}`),
    row('Growth', `${m.new24h} new in 24h, ${m.new7d} new in 7d`),
  );
  if (m.routedShare != null) lines.push(row('Routed via quote', `${pct(m.routedShare)} of paired coins' total volume`));
  if (m.newest) lines.push(row('Newest pair', `${m.newest.baseSymbol} on ${m.newest.dexId}, ${formatAge(m.newest.createdAt, now)} old`));
  lines.push(row('Pairing health', grade));
  for (const c of h.components) {
    lines.push(`${label(`  ${c.label}`.padEnd(18))}${color ? cyan(bar(c.points / c.max)) : bar(c.points / c.max)} ${String(c.points).padStart(4)}/${c.max}  ${label(c.detail)}`);
  }
  return lines.join('\n');
}

const fmtMetric = (key, v) => {
  if (v == null) return '-';
  if (['volume24h', 'flowUsd', 'liquidityUsd'].includes(key)) return compactUsd(v);
  if (['top3Share', 'buyRatio'].includes(key)) return pct(v);
  return String(v);
};

/** Side by side table for compare mode. */
export function renderCompare(cmp, { color = false } = {}) {
  const head = ['METRIC', ...cmp.labels];
  const body = cmp.metrics.map((m) => [m.label, ...m.values.map((v, i) => `${fmtMetric(m.key, v)}${m.leader === i ? ' *' : '  '}`)]);
  const widths = head.map((_, i) => Math.max(...[head, ...body].map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('   ').trimEnd();
  const out = [color ? bold(line(head)) : line(head), ...body.map(line)];
  out.push('', color ? dim('* leader on that metric. Flow is an estimate: 24h volume x buys / (buys + sells).') : '* leader on that metric. Flow is an estimate: 24h volume x buys / (buys + sells).');
  return out.join('\n');
}

const signed = (n, f = String) => (n > 0 ? `+${f(n)}` : n < 0 ? `-${f(-n)}` : f(0));

/** Growth table for `moons history`. */
export function renderHistory(series, { color = false, limit = 20 } = {}) {
  if (!series.length) return 'No snapshots yet. Run moons <mint> --history <file> (optionally with --watch) first.';
  const blocks = [];
  for (const s of series) {
    const g = s.growth;
    const title = `${s.symbol || s.mint} (${s.chain}), ${g.snapshots} snapshots, ${stamp(g.from)} to ${stamp(g.to)} UTC`;
    const head = ['TIME (UTC)', 'PAIRS', 'NEW', 'VOL 24H', 'FLOW EST', 'LIQUIDITY', 'HEALTH'];
    const pts = s.points.slice(-limit);
    const rows = pts.map((p, i) => {
      const prev = i > 0 ? pts[i - 1] : s.points[s.points.length - pts.length - 1];
      const fresh = prev ? (p.pairAddresses || []).filter((a) => !(prev.pairAddresses || []).includes(a)).length : 0;
      return [stamp(p.t), String(p.pairs), prev ? `+${fresh}` : '-', compactUsd(p.volume24h), compactUsd(p.flowUsd), compactUsd(p.liquidityUsd), String(p.health)];
    });
    const widths = head.map((_, i) => Math.max(...[head, ...rows].map((r) => r[i].length)));
    const line = (r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
    const growth = `Growth: pairs ${signed(g.pairs)}, volume ${signed(g.volume24h, compactUsd)}, flow ${signed(g.flowUsd, compactUsd)}, liquidity ${signed(g.liquidityUsd, compactUsd)}, health ${signed(g.health)}, ${g.uniquePairsSeen} unique pairs seen`;
    blocks.push([color ? bold(title) : title, color ? bold(line(head)) : line(head), ...rows.map(line), growth].join('\n'));
  }
  return blocks.join('\n\n');
}

export const stamp = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
