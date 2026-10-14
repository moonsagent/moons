import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { SORT_KEYS } from './core.js';
import { ecosystemReport, compareTokens } from './ecosystem.js';
import { recordSnapshot, snapshotFromReport, computeDelta, loadHistory, historySeries, DEFAULT_HISTORY_FILE } from './history.js';
import { buildAlerts, sendAlerts } from './alerts.js';
import { renderGraphSvg, renderGraphHtml } from './graph.js';
import { renderTable, renderReportSummary, renderCompare, renderHistory, renderCsv, useColor, dim, compactUsd, stamp } from './format.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const HELP = `moons ${VERSION}
every coin that trades against yours.

Usage
  moons <mint> [options]              Ecosystem report for a quote token
  moons compare <mintA> <mintB> ...   Side by side ecosystems (2 to 5 tokens)
  moons history [--history file]      Growth over time from stored snapshots
  moons ui [--port 4646]              Local dashboard
  moons mcp                           MCP server on stdio for AI agents

Report options
  --chain <id>              DexScreener chain id (default: solana)
  --sort <key>              ${SORT_KEYS.join(' | ')} (default: volume)
  --min-liquidity <usd>     Hide pairs with less liquidity (default: 0)
  --limit <n>               Rows to show, 0 for all (default: 50)
  --json | --csv            Machine readable output
  --skip-routing            Skip the batch lookup of paired coins' other pools
  --graph <file>            Write the pair network: .html (interactive) or .svg
  --watch <seconds>         Re-poll every N seconds (min 5), show deltas and new pairs
  --history <file>          Append a snapshot per poll to a JSON file
  --alert-webhook <url>     POST new pairs and threshold crossings (Discord compatible)
  --telegram-token <token>  Telegram bot token (or $MOONS_TELEGRAM_TOKEN)
  --telegram-chat <id>      Telegram chat id (or $MOONS_TELEGRAM_CHAT)
  --alert-flow <usd>        Alert when est. flow into quote crosses this value
  --alert-volume <usd>      Alert when ecosystem 24h volume crosses this value
  --alert-health <score>    Alert when the health score crosses this value
  --alert-pairs <n>         Alert when the pair count crosses this value

Other options
  --mint <address>          history: only this token
  --port <n>                ui: port (default: 4646)
  --refresh <seconds>       ui: auto refresh interval (default: 30)
  --api <url>               DexScreener base URL (default: $MOONS_API or https://api.dexscreener.com)
  --gecko-api <url>         GeckoTerminal base URL (default: $MOONS_GECKO_API or https://api.geckoterminal.com/api/v2)
  -h, --help                Show this help
  -v, --version             Show version

Flow into quote is an estimate: volume.h24 x buys / (buys + sells), summed over pairs.

Examples
  moons <mint> --sort flow --min-liquidity 1000
  moons <mint> --graph pairs.html
  moons <mint> --watch 60 --history moons.json --alert-webhook https://discord.com/api/webhooks/...
  moons compare <mintA> <mintB>
  moons history --history moons.json
`;

export class UsageError extends Error {}
const COMMANDS = new Set(['compare', 'history', 'ui', 'mcp', 'scan']);

const OPTIONS = {
  chain: { type: 'string', default: 'solana' },
  sort: { type: 'string', default: 'volume' },
  'min-liquidity': { type: 'string', default: '0' },
  limit: { type: 'string' },
  json: { type: 'boolean', default: false },
  csv: { type: 'boolean', default: false },
  'skip-routing': { type: 'boolean', default: false },
  graph: { type: 'string' },
  watch: { type: 'string' },
  history: { type: 'string' },
  'alert-webhook': { type: 'string' },
  'telegram-token': { type: 'string' },
  'telegram-chat': { type: 'string' },
  'alert-flow': { type: 'string' },
  'alert-volume': { type: 'string' },
  'alert-health': { type: 'string' },
  'alert-pairs': { type: 'string' },
  mint: { type: 'string' },
  port: { type: 'string' },
  refresh: { type: 'string' },
  api: { type: 'string' },
  'gecko-api': { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

function toNumber(name, v, { min = 0, int = false } = {}) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw new UsageError(`--${name} must be ${int ? 'an integer' : 'a number'} >= ${min}, got "${v}"`);
  return n;
}

export function parseCli(argv, env = process.env) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values: v, positionals } = parsed;
  if (v.help || v.version) return { help: v.help, version: v.version };
  let command = 'report';
  let pos = positionals;
  if (COMMANDS.has(pos[0])) {
    command = pos[0] === 'scan' ? 'report' : pos[0];
    pos = pos.slice(1);
  }
  if (!SORT_KEYS.includes(v.sort)) throw new UsageError(`--sort must be one of: ${SORT_KEYS.join(', ')}`);
  if (v.json && v.csv) throw new UsageError('Use either --json or --csv, not both.');
  if (v.graph && !/\.(html?|svg)$/i.test(v.graph)) throw new UsageError('--graph needs a file ending in .html or .svg');
  const args = {
    command,
    chain: v.chain.toLowerCase(),
    sort: v.sort,
    minLiquidity: toNumber('min-liquidity', v['min-liquidity']),
    limit: toNumber('limit', v.limit ?? (command === 'history' ? '20' : '50'), { int: true }),
    json: v.json,
    csv: v.csv,
    routing: !v['skip-routing'],
    graph: v.graph,
    watch: v.watch === undefined ? 0 : toNumber('watch', v.watch, { min: 5 }),
    history: v.history,
    webhook: v['alert-webhook'] || env.MOONS_WEBHOOK,
    telegramToken: v['telegram-token'] || env.MOONS_TELEGRAM_TOKEN,
    telegramChat: v['telegram-chat'] || env.MOONS_TELEGRAM_CHAT,
    thresholds: {
      flow: toNumber('alert-flow', v['alert-flow']),
      volume: toNumber('alert-volume', v['alert-volume']),
      health: toNumber('alert-health', v['alert-health']),
      pairs: toNumber('alert-pairs', v['alert-pairs']),
    },
    mint: v.mint,
    port: toNumber('port', v.port ?? '4646', { int: true }),
    refresh: toNumber('refresh', v.refresh ?? '30', { min: 5 }),
    apiBase: v.api || env.MOONS_API || undefined,
    geckoBase: v['gecko-api'] || env.MOONS_GECKO_API || undefined,
  };
  if (command === 'report') {
    if (pos.length !== 1) throw new UsageError('Expected exactly one token address. Run moons --help.');
    args.mints = [pos[0].trim()];
  } else if (command === 'compare') {
    if (pos.length < 2 || pos.length > 5) throw new UsageError('compare needs 2 to 5 token addresses.');
    if (args.csv) throw new UsageError('compare supports --json, not --csv.');
    args.mints = pos.map((p) => p.trim());
  } else if (pos.length) {
    throw new UsageError(`Unexpected argument "${pos[0]}" for ${command}.`);
  }
  if (args.telegramToken && !args.telegramChat) throw new UsageError('--telegram-token needs --telegram-chat.');
  return args;
}

function clientOpts(args, io) {
  const o = { chain: args.chain };
  if (args.apiBase) o.apiBase = args.apiBase;
  if (args.geckoBase) o.geckoBase = args.geckoBase;
  if (io.retryDelay != null) o.baseDelay = io.retryDelay;
  return o;
}

function signed(n, f = String) {
  return n > 0 ? `+${f(n)}` : n < 0 ? `-${f(-n)}` : `+${f(0)}`;
}

function writeGraph(file, report) {
  writeFileSync(file, /\.svg$/i.test(file) ? renderGraphSvg(report) : renderGraphHtml(report));
}

async function runReport(args, io) {
  const { stdout, stderr } = io;
  const color = !args.json && !args.csv && useColor(stdout);
  const opts = { ...clientOpts(args, io), sort: args.sort, minLiquidity: args.minLiquidity, enrich: args.routing, limit: 0 };
  const mint = args.mints[0];
  let prevSnap = null;
  let polls = 0;
  for (;;) {
    let report;
    try {
      report = await ecosystemReport(mint, { ...opts, cacheTtl: 0, now: io.now?.() });
    } catch (err) {
      stderr.write(`moons: ${err.message}\n`);
      if (!args.watch) return 1;
    }
    if (report) {
      if (report.enrichError) stderr.write(`moons: routing lookup skipped (${report.enrichError})\n`);
      let snapshot = snapshotFromReport(report);
      let previous = prevSnap;
      if (args.history) {
        try {
          const rec = recordSnapshot(args.history, report);
          previous = rec.previous ?? prevSnap;
          snapshot = rec.snapshot;
        } catch (err) {
          stderr.write(`moons: ${err.message}\n`);
          return 1;
        }
      }
      const delta = computeDelta(previous, snapshot);
      const newKeys = new Set(delta?.newPairs ?? []);
      const shown = args.limit > 0 ? { ...report, pairs: report.pairs.slice(0, args.limit) } : report;
      if (args.json) stdout.write(`${JSON.stringify({ ...shown, delta }, null, 2)}\n`);
      else if (args.csv) stdout.write(`${renderCsv(shown.pairs)}\n`);
      else {
        if (args.watch) stdout.write(`\n[${stamp(report.fetchedAt)} UTC] poll ${polls + 1}, ${newKeys.size} new pair(s)\n`);
        let out = `${renderReportSummary(report, { color })}\n\n${renderTable(shown.pairs, { color, newKeys, now: report.fetchedAt })}`;
        if (shown.pairs.length < report.pairs.length) {
          const note = `Showing ${shown.pairs.length} of ${report.pairs.length}. Use --limit 0 to show all.`;
          out += `\n${color ? dim(note) : note}`;
        }
        if (delta) {
          const d = `Since ${stamp(previous.t)} UTC: pairs ${signed(delta.pairs)}, volume ${signed(delta.volume24h, compactUsd)}, flow ${signed(delta.flowUsd, compactUsd)}, health ${signed(delta.health)}, ${delta.newPairs.length} new, ${delta.removedPairs} gone`;
          out += `\n${color ? dim(d) : d}`;
        }
        stdout.write(`${out}\n`);
      }
      if (args.graph) {
        writeGraph(args.graph, report);
        if (!args.json && !args.csv) stderr.write(`moons: wrote ${args.graph}\n`);
      }
      if (args.webhook || args.telegramToken) {
        const events = buildAlerts({ report, snapshot, previous, delta, thresholds: args.thresholds });
        const results = await sendAlerts(events, report, { webhook: args.webhook, telegramToken: args.telegramToken, telegramChat: args.telegramChat, baseDelay: io.retryDelay });
        for (const r of results) stderr.write(`moons: alert to ${r.target} ${r.ok ? `sent (${events.length} event(s))` : `failed: ${r.error}`}\n`);
      }
      prevSnap = snapshot;
      if (!args.watch) return 0;
    }
    polls++;
    if (io.maxPolls && polls >= io.maxPolls) return 0;
    await new Promise((r) => setTimeout(r, io.watchMs ?? args.watch * 1000));
  }
}

async function runCompare(args, io) {
  try {
    const cmp = await compareTokens(args.mints, { ...clientOpts(args, io), minLiquidity: args.minLiquidity, enrich: args.routing, now: io.now?.() });
    if (args.json) {
      const slim = { ...cmp, reports: cmp.reports.map((r) => ({ ...r, pairs: args.limit > 0 ? r.pairs.slice(0, args.limit) : r.pairs })) };
      io.stdout.write(`${JSON.stringify(slim, null, 2)}\n`);
    } else {
      const color = useColor(io.stdout);
      const w = Math.max(...cmp.labels.map((l) => l.length));
      const heads = cmp.reports.map((r, i) => `${cmp.labels[i].padEnd(w)}  ${r.mint} (${r.chain}), health ${r.health.score}/100 ${r.health.grade}`).join('\n');
      io.stdout.write(`${heads}\n\n${renderCompare(cmp, { color })}\n`);
    }
    return 0;
  } catch (err) {
    io.stderr.write(`moons: ${err.message}\n`);
    return 1;
  }
}

function runHistory(args, io) {
  const file = args.history || DEFAULT_HISTORY_FILE;
  try {
    const series = historySeries(loadHistory(file), { mint: args.mint, chain: args.mint ? args.chain : undefined });
    if (args.json) io.stdout.write(`${JSON.stringify(series.map(({ points, ...s }) => ({ ...s, points: points.map(({ pairAddresses, ...p }) => p) })), null, 2)}\n`);
    else io.stdout.write(`${renderHistory(series, { color: useColor(io.stdout), limit: args.limit || Infinity })}\n`);
    return 0;
  } catch (err) {
    io.stderr.write(`moons: ${err.message}\n`);
    return 1;
  }
}

async function runUi(args, io) {
  const { startDashboard } = await import('./server.js');
  const opts = clientOpts(args, io);
  const d = await startDashboard({ port: args.port, version: VERSION, refresh: args.refresh, options: opts });
  io.stdout.write(`moons dashboard on ${d.url}\nPress Ctrl+C to stop.\n`);
  io.onServer?.(d);
  return new Promise((resolve) => d.server.on('close', () => resolve(0)));
}

async function runMcp(args, io) {
  const { runMcpServer } = await import('./mcp.js');
  return runMcpServer({ stdin: io.stdin || process.stdin, stdout: io.stdout, stderr: io.stderr, version: VERSION, options: clientOpts(args, io) });
}

/**
 * Run the CLI. Returns an exit code. Test hooks in `io`: stdout, stderr, stdin,
 * retryDelay, maxPolls, watchMs, now, onServer.
 */
export async function main(argv, io = {}) {
  io = { stdout: process.stdout, stderr: process.stderr, ...io };
  let args;
  try {
    args = parseCli(argv);
  } catch (err) {
    io.stderr.write(`moons: ${err.message}\n`);
    return 2;
  }
  if (args.help) return io.stdout.write(HELP), 0;
  if (args.version) return io.stdout.write(`${VERSION}\n`), 0;
  switch (args.command) {
    case 'compare':
      return runCompare(args, io);
    case 'history':
      return runHistory(args, io);
    case 'ui':
      return runUi(args, io);
    case 'mcp':
      return runMcp(args, io);
    default:
      return runReport(args, io);
  }
}
