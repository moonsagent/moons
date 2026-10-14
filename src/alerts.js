// Alerts: new pairs and threshold crossings, delivered to a Discord-compatible
// webhook (content plus a JSON payload) and/or Telegram sendMessage.
import { postJson, redact } from './client.js';
import { compactUsd } from './format.js';

export const DEFAULT_TELEGRAM_API = 'https://api.telegram.org';

/** Metrics that support thresholds: snapshot key, label, formatter. */
export const THRESHOLDS = {
  flow: { key: 'flowUsd', label: 'Est. flow into quote 24h', fmt: compactUsd },
  volume: { key: 'volume24h', label: 'Ecosystem volume 24h', fmt: compactUsd },
  health: { key: 'health', label: 'Pairing health', fmt: (v) => `${v}/100` },
  pairs: { key: 'pairs', label: 'Paired coins', fmt: String },
};

/** Did a value cross a threshold between two readings? Returns 'up', 'down' or null. */
export function crossing(prev, cur, threshold) {
  if (prev == null || cur == null || threshold == null) return null;
  if (prev < threshold && cur >= threshold) return 'up';
  if (prev >= threshold && cur < threshold) return 'down';
  return null;
}

/**
 * Build alert events from the current report, the previous snapshot and the delta.
 * thresholds: { flow?, volume?, health?, pairs? } numbers.
 */
export function buildAlerts({ report, snapshot, previous, delta, thresholds = {} }) {
  const events = [];
  if (delta?.newPairs?.length) {
    const byAddr = new Map(report.pairs.map((p) => [p.pairAddress, p]));
    const pairs = delta.newPairs.map((a) => byAddr.get(a)).filter(Boolean);
    if (pairs.length) events.push({ type: 'new_pairs', count: pairs.length, pairs });
  }
  for (const [name, t] of Object.entries(thresholds)) {
    const spec = THRESHOLDS[name];
    if (!spec || t == null || !previous) continue;
    const dir = crossing(previous[spec.key], snapshot[spec.key], t);
    if (dir) events.push({ type: 'threshold', metric: name, label: spec.label, threshold: t, direction: dir, from: previous[spec.key], to: snapshot[spec.key] });
  }
  return events;
}

/** Plain text message, at most 1900 characters (Discord limit is 2000). */
export function formatAlertText(events, report) {
  const name = report.quote?.symbol || report.mint;
  const lines = [`moons: ${name} (${report.chain})`];
  for (const e of events) {
    if (e.type === 'new_pairs') {
      lines.push(`${e.count} new pair${e.count === 1 ? '' : 's'}:`);
      for (const p of e.pairs.slice(0, 10)) {
        lines.push(`+ ${p.baseSymbol}/${p.quoteSymbol} on ${p.dexId}, vol ${compactUsd(p.volume24h)}, liq ${compactUsd(p.liquidityUsd)}${p.url ? `, ${p.url}` : ''}`);
      }
      if (e.pairs.length > 10) lines.push(`and ${e.pairs.length - 10} more`);
    } else {
      const spec = THRESHOLDS[e.metric];
      lines.push(`${e.label} crossed ${e.direction === 'up' ? 'above' : 'below'} ${spec.fmt(e.threshold)}: ${spec.fmt(e.from)} to ${spec.fmt(e.to)}`);
    }
  }
  const text = lines.join('\n');
  return text.length > 1900 ? `${text.slice(0, 1897)}...` : text;
}

/** JSON payload sent next to the Discord `content` field. */
export function alertPayload(events, report) {
  return {
    mint: report.mint,
    chain: report.chain,
    symbol: report.quote?.symbol ?? null,
    at: new Date(report.fetchedAt).toISOString(),
    health: report.health.score,
    flowUsd: Math.round(report.metrics.flowUsd),
    events: events.map((e) =>
      e.type === 'new_pairs'
        ? { ...e, pairs: e.pairs.map(({ pairAddress, baseSymbol, baseAddress, dexId, volume24h, liquidityUsd, url }) => ({ pairAddress, baseSymbol, baseAddress, dexId, volume24h, liquidityUsd, url })) }
        : e,
    ),
  };
}

/**
 * Deliver events. Never throws: returns [{target, ok, error?}].
 * opts: webhook, telegramToken, telegramChat, telegramApi, plus client options.
 */
export async function sendAlerts(events, report, opts = {}) {
  if (!events.length) return [];
  const text = formatAlertText(events, report);
  const results = [];
  const clientOpts = { baseDelay: opts.baseDelay, fetchImpl: opts.fetchImpl };
  if (opts.webhook) {
    try {
      await postJson(opts.webhook, { content: text, username: 'moons', moons: alertPayload(events, report) }, clientOpts);
      results.push({ target: 'webhook', ok: true });
    } catch (err) {
      results.push({ target: 'webhook', ok: false, error: err.message });
    }
  }
  if (opts.telegramToken && opts.telegramChat) {
    const base = String(opts.telegramApi || process.env.MOONS_TELEGRAM_API || DEFAULT_TELEGRAM_API).replace(/\/+$/, '');
    const url = `${base}/bot${opts.telegramToken}/sendMessage`;
    try {
      await postJson(url, { chat_id: opts.telegramChat, text, disable_web_page_preview: true }, clientOpts);
      results.push({ target: 'telegram', ok: true });
    } catch (err) {
      results.push({ target: 'telegram', ok: false, error: redact(err.message) });
    }
  }
  return results;
}
