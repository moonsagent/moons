import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../src/server.js';
import { startMockServer, HUB_MINT, FIXTURE_MINT } from '../scripts/mock-server.js';

async function withDashboard(fn, mockOpts = {}) {
  const srv = await startMockServer(mockOpts);
  const d = await startDashboard({ port: 0, version: '9.9.9', options: { apiBase: srv.url, geckoBase: srv.gecko, cacheTtl: 0 } });
  try {
    await fn(d, srv);
  } finally {
    await d.close();
    await srv.close();
  }
}

test('dashboard serves the branded page and the JSON API', async () => {
  await withDashboard(async (d) => {
    const page = await (await fetch(`${d.url}/`)).text();
    assert.match(page, /<title>moons dashboard<\/title>/);
    assert.match(page, /#8DB8FF/);
    assert.match(page, /v9\.9\.9/);
    assert.ok(!page.includes('__CONFIG__') && !page.includes('__LOGO__') && !page.includes('/*__GRAPH_SCRIPT__*/'));
    assert.ok(!/<script[^>]+src=|<link[^>]+stylesheet/.test(page), 'no external assets');
    const health = await (await fetch(`${d.url}/api/health`)).json();
    assert.deepEqual(health, { ok: true, version: '9.9.9' });
    const res = await fetch(`${d.url}/api/report?mint=${HUB_MINT}`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.report.metrics.totalPairs, 28);
    assert.equal(j.ohlcv.candles.length, 72);
    assert.match(j.graphSvg, /^<svg/);
    assert.deepEqual(j.newSinceRefresh, []);
    assert.equal((await fetch(`${d.url}/api/report`)).status, 400);
    assert.equal((await fetch(`${d.url}/nope`)).status, 404);
    const font = await fetch(`${d.url}/fonts/geist.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.ok((await font.arrayBuffer()).byteLength > 1000);
    assert.equal((await fetch(`${d.url}/fonts/../server.js`)).status, 404);
    assert.match(page, /url\(\/fonts\/geist\.woff2\)/);
  });
});

test('dashboard embeds initial data for ?mint= and tracks new pairs between refreshes', async () => {
  const { loadFixture } = await import('../scripts/mock-server.js');
  const all = loadFixture();
  const first = all.filter((p) => p.baseToken.symbol !== 'FRESH');
  await withDashboard(async (d) => {
    const page = await (await fetch(`${d.url}/?mint=${FIXTURE_MINT}`)).text();
    assert.match(page, /"initial":\{"report":/);
    const j = await (await fetch(`${d.url}/api/report?mint=${FIXTURE_MINT}`)).json();
    assert.deepEqual(j.newSinceRefresh, ['PairFFF1111111111111111111111111111111111111']);
  }, { responses: [first, all] });
});

test('dashboard returns 502 with a message when the API fails', async () => {
  await withDashboard(async (d) => {
    const res = await fetch(`${d.url}/api/report?mint=${FIXTURE_MINT}`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /HTTP 404/);
  }, { failures: 1000, failStatus: 404 });
});
