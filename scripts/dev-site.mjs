// Local dev server for the website: serves docs/ like Vercel does and routes
// /api/<name> to api/<name>.js handlers (moons has none today, the browser talks
// to DexScreener and GeckoTerminal directly, but the routing is here for later).
//
// Usage:
//   node scripts/dev-site.mjs [--port 5173] [--mock]
// With --mock it also starts the mock DexScreener/GeckoTerminal API and prints a
// URL with ?api=... so the page reads fixtures instead of the live APIs.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const docs = join(root, 'docs');
const apiDir = join(root, 'api');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Vercel style helpers on top of node:http. */
function vercelify(req, res, url) {
  req.query = Object.fromEntries(url.searchParams);
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => {
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
    return res;
  };
  res.send = (body) => { res.end(body); return res; };
}

export function createSiteServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const name = url.pathname.slice(5).replace(/\/+$/, '');
        const file = join(apiDir, `${name}.js`);
        if (!/^[\w-]+$/.test(name) || !existsSync(file)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'not found' }));
        }
        vercelify(req, res, url);
        const mod = await import(pathToFileURL(file).href);
        return await mod.default(req, res);
      }
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(docs, path));
      if (!file.startsWith(docs + sep)) {
        res.writeHead(403);
        return res.end('forbidden');
      }
      const s = await stat(file).catch(() => null);
      if (!s || !s.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err?.message || err));
    }
  });
}

/** Start the site on 127.0.0.1. Resolves with { url, close }. */
export function startSite({ port = 0 } = {}) {
  const server = createSiteServer();
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      ok({ url, server, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--port');
  const site = await startSite({ port: i >= 0 ? Number(args[i + 1]) : 5173 });
  console.log(`moons site on ${site.url}`);
  if (args.includes('--mock')) {
    const { startMockServer, HUB_MINT } = await import('./mock-server.js');
    const mock = await startMockServer({ rebase: true });
    console.log(`mock APIs on ${mock.url}`);
    console.log(`open ${site.url}/?api=${encodeURIComponent(mock.url)}&token=${HUB_MINT}`);
  }
}
