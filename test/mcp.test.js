import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockServer, FIXTURE_MINT, PAD_MINT } from '../scripts/mock-server.js';

const BIN = fileURLToPath(new URL('../bin/moons.js', import.meta.url));

/** Spawn `moons mcp`, send messages, collect one response per request id. */
async function session(messages, apiBase) {
  const child = spawn(process.execPath, [BIN, 'mcp', '--api', apiBase], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  for (const m of messages) child.stdin.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
  child.stdin.end();
  const code = await new Promise((r) => child.on('close', r));
  const responses = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { code, responses, err, byId: (id) => responses.find((r) => r.id === id) };
}

test('mcp: initialize, tools/list, tools/call against the mock API', async () => {
  const srv = await startMockServer();
  try {
    const s = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ecosystem_report', arguments: { mint: FIXTURE_MINT, limit: 2 } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'scan_pairs', arguments: { mint: FIXTURE_MINT, sort: 'age', limit: 1 } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'compare_tokens', arguments: { mints: [FIXTURE_MINT, PAD_MINT] } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'new_pairs_since', arguments: { mint: FIXTURE_MINT, since: '3650d' } } },
      { jsonrpc: '2.0', id: 7, method: 'ping' },
    ], srv.url);
    assert.equal(s.code, 0);
    assert.equal(s.responses.length, 7, 'no response to the notification');
    const init = s.byId(1).result;
    assert.equal(init.protocolVersion, '2025-03-26');
    assert.deepEqual(init.capabilities, { tools: {} });
    assert.equal(init.serverInfo.name, 'moons');
    const tools = s.byId(2).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ['scan_pairs', 'ecosystem_report', 'compare_tokens', 'new_pairs_since']);
    assert.ok(tools.every((t) => t.inputSchema.type === 'object' && t.description));
    const report = JSON.parse(s.byId(3).result.content[0].text);
    assert.equal(report.metrics.totalPairs, 6);
    assert.equal(report.topPairs.length, 2);
    assert.equal(typeof report.health.score, 'number');
    assert.match(report.flowNote, /estimate/);
    const scan = JSON.parse(s.byId(4).result.content[0].text);
    assert.equal(scan.pairs[0].pair, 'FRESH/MOONS');
    const cmp = JSON.parse(s.byId(5).result.content[0].text);
    assert.deepEqual(cmp.tokens.map((t) => t.label), ['MOONS', 'PAD']);
    const fresh = JSON.parse(s.byId(6).result.content[0].text);
    assert.equal(fresh.count, 6);
    assert.deepEqual(s.byId(7).result, {});
    assert.match(s.err, /MCP server/);
  } finally {
    await srv.close();
  }
});

test('mcp: protocol errors and tool errors', async () => {
  const srv = await startMockServer({ failures: 1000, failStatus: 404 });
  try {
    const s = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      { jsonrpc: '2.0', id: 2, method: 'resources/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'scan_pairs', arguments: {} } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'new_pairs_since', arguments: { mint: 'x', since: 'later' } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'scan_pairs', arguments: { mint: FIXTURE_MINT } } },
      'not json',
    ], srv.url);
    assert.equal(s.byId(1).result.protocolVersion, '2025-06-18');
    assert.equal(s.byId(2).error.code, -32601);
    assert.equal(s.byId(3).error.code, -32602);
    assert.equal(s.byId(4).error.code, -32602);
    assert.equal(s.byId(5).error.code, -32602);
    const toolErr = s.byId(6).result;
    assert.equal(toolErr.isError, true);
    assert.match(toolErr.content[0].text, /HTTP 404/);
    assert.equal(s.byId(null).error.code, -32700);
  } finally {
    await srv.close();
  }
});
