import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, parseCli } from '../src/cli.js';
import { scanPairs } from '../src/index.js';
import { getJson } from '../src/client.js';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer, loadFixture, FIXTURE_MINT, PAD_MINT, FIXTURE_TIME } from '../scripts/mock-server.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'moons-cli-'));

function sink() {
  let data = '';
  return { write: (s) => { data += s; return true; }, get text() { return data; }, isTTY: false };
}

async function run(argv, srvOpts, io = {}) {
  const srv = await startMockServer(srvOpts);
  const stdout = sink();
  const stderr = sink();
  try {
    const extra = typeof io.argv === 'function' ? io.argv(srv) : [];
    const code = await main([...argv, ...extra, '--api', srv.url], { stdout, stderr, retryDelay: 5, now: () => FIXTURE_TIME, ...io });
    return { code, out: stdout.text, err: stderr.text, srv };
  } finally {
    await srv.close();
  }
}

test('scanPairs against the mock server', async () => {
  const srv = await startMockServer();
  try {
    const r = await scanPairs(FIXTURE_MINT, { apiBase: srv.url, sort: 'liquidity', minLiquidity: 5000, limit: 2 });
    assert.equal(r.summary.totalPairs, 4);
    assert.deepEqual(r.pairs.map((p) => p.baseSymbol), ['MWHALE', 'TESTFROGGYLONGTICKER']);
    assert.equal(srv.state.requests[0], `/token-pairs/v1/solana/${FIXTURE_MINT}`);
  } finally {
    await srv.close();
  }
});

test('getJson retries on 429 and then succeeds', async () => {
  const srv = await startMockServer({ failures: 2 });
  try {
    const data = await getJson(`${srv.url}/token-pairs/v1/solana/${FIXTURE_MINT}`, { baseDelay: 5 });
    assert.equal(data.length, loadFixture().length);
    assert.equal(srv.state.requests.length, 3);
  } finally {
    await srv.close();
  }
});

test('getJson gives up after retries on persistent 5xx', async () => {
  const srv = await startMockServer({ failures: 100, failStatus: 503 });
  try {
    await assert.rejects(getJson(`${srv.url}/x`, { baseDelay: 1, retries: 2 }), /HTTP 503/);
    assert.equal(srv.state.requests.length, 3);
  } finally {
    await srv.close();
  }
});

test('getJson does not retry on 404', async () => {
  const srv = await startMockServer();
  try {
    await assert.rejects(getJson(`${srv.url}/nope`, { baseDelay: 1 }), /HTTP 404/);
    assert.equal(srv.state.requests.length, 1);
  } finally {
    await srv.close();
  }
});

test('cli prints summary and table', async () => {
  const { code, out } = await run([FIXTURE_MINT], {});
  assert.equal(code, 0);
  assert.match(out, /Pairs\s+6 \(5 active, 4 on pump\.fun\/PumpSwap\)/);
  assert.match(out, /Flow into quote\s+\$417K est\./);
  assert.match(out, /Concentration\s+top 3 = 94% of volume/);
  assert.match(out, /Growth\s+2 new in 24h, 4 new in 7d/);
  assert.match(out, /Routed via quote\s+68%/);
  assert.match(out, /Pairing health\s+62\/100 moderate/);
  assert.match(out, /MWHALE\/MOONS/);
  assert.match(out, /FLOW EST/);
  assert.ok(!out.includes('\x1b['));
});

test('cli --json outputs parseable JSON', async () => {
  const { code, out } = await run([FIXTURE_MINT, '--json', '--limit', '3'], {});
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.equal(data.pairs.length, 3);
  assert.equal(data.summary.totalPairs, 6);
});

test('cli --csv outputs header plus one line per pair', async () => {
  const { code, out } = await run([FIXTURE_MINT, '--csv', '--sort', 'age'], {});
  assert.equal(code, 0);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 7);
  assert.ok(lines[1].includes('FRESH'));
  assert.ok(lines[0].endsWith('flowUsd,routeShare,url'));
});

test('cli --watch marks new pairs on the second poll', async () => {
  const all = loadFixture();
  const first = all.filter((p) => p.baseToken.symbol !== 'FRESH');
  const { code, out } = await run([FIXTURE_MINT, '--watch', '5'], { responses: [first, all] }, { maxPolls: 2, watchMs: 1 });
  assert.equal(code, 0);
  assert.match(out, /poll 1, 0 new pair/);
  assert.match(out, /poll 2, 1 new pair/);
  assert.match(out, /NEW\s+FRESH\/MOONS/);
});

test('cli exits 1 with a clear message on API errors', async () => {
  const { code, err } = await run([FIXTURE_MINT], { failures: 100, failStatus: 500 });
  assert.equal(code, 1);
  assert.match(err, /moons: HTTP 500/);
});

test('cli usage errors exit 2', async () => {
  const stderr = sink();
  assert.equal(await main([], { stdout: sink(), stderr }), 2);
  assert.match(stderr.text, /Expected exactly one token address/);
  assert.equal(await main(['x', '--sort', 'bad'], { stdout: sink(), stderr }), 2);
  assert.equal(await main(['x', '--json', '--csv'], { stdout: sink(), stderr }), 2);
  assert.equal(await main(['x', '--limit', 'abc'], { stdout: sink(), stderr }), 2);
  assert.equal(await main(['x', '--bogus'], { stdout: sink(), stderr }), 2);
});

test('cli --help and parse defaults', async () => {
  const stdout = sink();
  assert.equal(await main(['--help'], { stdout, stderr: sink() }), 0);
  assert.match(stdout.text, /--min-liquidity/);
  const a = parseCli(['mint']);
  assert.equal(a.chain, 'solana');
  assert.equal(a.limit, 50);
  assert.equal(a.watch, 0);
  assert.equal(a.command, 'report');
  assert.equal(parseCli(['compare', 'a', 'b']).command, 'compare');
  assert.equal(parseCli(['history']).limit, 20);
  assert.equal(parseCli(['ui', '--port', '0']).port, 0);
  assert.equal(parseCli(['m'], { MOONS_TELEGRAM_TOKEN: 't', MOONS_TELEGRAM_CHAT: 'c' }).telegramChat, 'c');
});

test('cli usage errors for subcommands and new flags', async () => {
  const stderr = sink();
  const io = { stdout: sink(), stderr };
  assert.equal(await main(['compare', 'a'], io), 2);
  assert.equal(await main(['compare', 'a', 'b', '--csv'], io), 2);
  assert.equal(await main(['history', 'extra'], io), 2);
  assert.equal(await main(['m', '--graph', 'out.png'], io), 2);
  assert.equal(await main(['m', '--telegram-token', 't'], io), 2);
  assert.equal(await main(['m', '--alert-flow', 'lots'], io), 2);
  assert.equal(await main(['m', '--watch', '1'], io), 2);
  assert.match(stderr.text, /compare needs 2 to 5/);
  assert.match(stderr.text, /--graph needs a file ending in \.html or \.svg/);
});

test('cli compare prints a side by side table', async () => {
  const { code, out } = await run(['compare', FIXTURE_MINT, PAD_MINT], {});
  assert.equal(code, 0);
  assert.match(out, /^METRIC\s+MOONS\s+PAD$/m);
  assert.match(out, /Pairs\s+6 \*\s+4/);
  assert.match(out, /leader on that metric/);
  const j = await run(['compare', FIXTURE_MINT, PAD_MINT, '--json', '--limit', '1'], {});
  const data = JSON.parse(j.out);
  assert.deepEqual(data.labels, ['MOONS', 'PAD']);
  assert.equal(data.reports[0].pairs.length, 1);
});

test('cli --graph writes html and svg files', async () => {
  const dir = tmp();
  const html = join(dir, 'g.html');
  const svg = join(dir, 'g.svg');
  assert.equal((await run([FIXTURE_MINT, '--graph', html], {})).code, 0);
  assert.equal((await run([FIXTURE_MINT, '--graph', svg, '--json'], {})).code, 0);
  assert.match(readFileSync(html, 'utf8'), /moonsGraph/);
  assert.match(readFileSync(svg, 'utf8'), /^<svg[^>]+class="mn-graph"/);
});

test('cli --history records snapshots, alerts on new pairs and crossings, history prints growth', async () => {
  const dir = tmp();
  const file = join(dir, 'h.json');
  const all = loadFixture();
  const first = all.filter((p) => p.baseToken.symbol !== 'FRESH' && p.baseToken.symbol !== 'SCAT');
  const r1 = await run([FIXTURE_MINT, '--history', file], { responses: [first] });
  assert.equal(r1.code, 0);
  assert.ok(existsSync(file));
  const r2 = await run([FIXTURE_MINT, '--history', file, '--alert-pairs', '6', '--telegram-chat', '7'], {}, {
    argv: (srv) => ['--alert-webhook', srv.webhook, '--telegram-token', '42:x'],
    env: undefined,
  });
  assert.equal(r2.code, 0);
  assert.match(r2.out, /NEW\s+FRESH\/MOONS/);
  assert.match(r2.out, /pairs \+2, .*2 new, 0 gone/);
  assert.match(r2.err, /alert to webhook sent \(2 event\(s\)\)/);
  assert.match(r2.err, /alert to telegram failed/, 'telegram api not pointed at the mock');
  const h = await run(['history', '--history', file], {});
  assert.equal(h.code, 0);
  assert.match(h.out, /MOONS \(solana\), 2 snapshots/);
  assert.match(h.out, /Growth: pairs \+2/);
  const hj = JSON.parse((await run(['history', '--history', file, '--json'], {})).out);
  assert.equal(hj[0].points.length, 2);
  assert.equal(hj[0].points[0].pairAddresses, undefined);
  const missing = await run(['history', '--history', join(dir, 'none.json')], {});
  assert.match(missing.out, /No snapshots yet/);
});

test('cli alerts reach a mocked Telegram API', async () => {
  const dir = tmp();
  const file = join(dir, 'h.json');
  const all = loadFixture();
  const first = all.filter((p) => p.baseToken.symbol !== 'FRESH');
  const srv = await startMockServer({ responses: [first, all] });
  const prev = process.env.MOONS_TELEGRAM_API;
  process.env.MOONS_TELEGRAM_API = srv.telegram;
  try {
    const io = { stdout: sink(), stderr: sink(), retryDelay: 1, now: () => FIXTURE_TIME };
    assert.equal(await main([FIXTURE_MINT, '--api', srv.url, '--history', file], io), 0);
    assert.equal(await main([FIXTURE_MINT, '--api', srv.url, '--history', file, '--telegram-token', '9:abc', '--telegram-chat', '55'], io), 0);
    const post = srv.state.posts.find((p) => p.url.startsWith('/telegram/'));
    assert.equal(post.url, '/telegram/bot9:abc/sendMessage');
    assert.equal(post.body.chat_id, '55');
    assert.match(post.body.text, /1 new pair:\n\+ FRESH\/MOONS on pumpfun/);
  } finally {
    if (prev === undefined) delete process.env.MOONS_TELEGRAM_API;
    else process.env.MOONS_TELEGRAM_API = prev;
    await srv.close();
  }
});
