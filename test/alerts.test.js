import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossing, buildAlerts, formatAlertText, sendAlerts } from '../src/alerts.js';
import { startMockServer } from '../scripts/mock-server.js';

const report = {
  mint: 'Q', chain: 'solana', fetchedAt: Date.parse('2026-10-14T12:00:00Z'), quote: { symbol: 'MOONS' },
  metrics: { flowUsd: 1200 }, health: { score: 55 },
  pairs: [{ pairAddress: 'P1', baseSymbol: 'NEWCOIN', quoteSymbol: 'MOONS', dexId: 'pumpfun', volume24h: 5000, liquidityUsd: 2000, url: 'https://dexscreener.com/solana/P1' }],
};
const snapshot = { flowUsd: 1200, health: 55, pairs: 7, volume24h: 9000 };
const previous = { flowUsd: 900, health: 61, pairs: 6, volume24h: 9000 };

test('crossing detects up and down moves only', () => {
  assert.equal(crossing(900, 1200, 1000), 'up');
  assert.equal(crossing(1200, 900, 1000), 'down');
  assert.equal(crossing(1000, 1200, 1000), null);
  assert.equal(crossing(null, 1200, 1000), null);
});

test('buildAlerts reports new pairs and threshold crossings', () => {
  const events = buildAlerts({ report, snapshot, previous, delta: { newPairs: ['P1', 'gone'] }, thresholds: { flow: 1000, health: 60, pairs: 10, volume: undefined } });
  assert.deepEqual(events.map((e) => e.type), ['new_pairs', 'threshold', 'threshold']);
  assert.equal(events[0].pairs[0].baseSymbol, 'NEWCOIN');
  assert.equal(events[1].direction, 'up');
  assert.equal(events[2].direction, 'down');
  assert.deepEqual(buildAlerts({ report, snapshot, previous: null, delta: null, thresholds: { flow: 1000 } }), []);
  const text = formatAlertText(events, report);
  assert.match(text, /1 new pair:/);
  assert.match(text, /\+ NEWCOIN\/MOONS on pumpfun/);
  assert.match(text, /crossed above \$1K: \$900 to \$1\.2K/);
  assert.match(text, /Pairing health crossed below 60\/100/);
});

test('sendAlerts posts Discord-compatible JSON and Telegram sendMessage', async () => {
  const srv = await startMockServer();
  try {
    const events = buildAlerts({ report, snapshot, previous, delta: { newPairs: ['P1'] } });
    const res = await sendAlerts(events, report, { webhook: srv.webhook, telegramToken: '123:SECRET', telegramChat: '-100', telegramApi: srv.telegram, baseDelay: 1 });
    assert.deepEqual(res, [{ target: 'webhook', ok: true }, { target: 'telegram', ok: true }]);
    const [hook, tg] = srv.state.posts;
    assert.equal(hook.url, '/webhook');
    assert.equal(typeof hook.body.content, 'string');
    assert.ok(hook.body.content.length <= 2000);
    assert.equal(hook.body.moons.events[0].type, 'new_pairs');
    assert.equal(hook.body.moons.symbol, 'MOONS');
    assert.equal(tg.url, '/telegram/bot123:SECRET/sendMessage');
    assert.equal(tg.body.chat_id, '-100');
    assert.match(tg.body.text, /NEWCOIN/);
  } finally {
    await srv.close();
  }
});

test('sendAlerts never throws and redacts the bot token', async () => {
  const srv = await startMockServer({ failures: 100, failStatus: 500 });
  try {
    const events = [{ type: 'new_pairs', count: 1, pairs: report.pairs }];
    const res = await sendAlerts(events, report, { webhook: `${srv.url}/webhook`, telegramToken: '123:SECRET', telegramChat: '1', telegramApi: srv.telegram, baseDelay: 1 });
    assert.equal(res.length, 2);
    assert.ok(res.every((r) => !r.ok));
    assert.ok(!res[1].error.includes('SECRET'));
    assert.deepEqual(await sendAlerts([], report, { webhook: 'http://unused' }), []);
  } finally {
    await srv.close();
  }
});
