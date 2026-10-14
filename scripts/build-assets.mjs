// Regenerate README/brand assets from real runs against the local mock APIs.
//   node scripts/build-assets.mjs [dashboardSnapshotDir]
// Writes assets/terminal.svg (real CLI output), assets/graph.svg (demo network) and,
// when a directory is given, dashboard.html there for screenshot rendering.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { ecosystemReport } from '../src/ecosystem.js';
import { renderGraphSvg } from '../src/graph.js';
import { startDashboard } from '../src/server.js';
import { startMockServer, FIXTURE_MINT, FIXTURE_TIME, HUB_MINT } from './mock-server.js';

const root = new URL('../', import.meta.url).pathname;
const C = { bg: '#060A14', bar: '#0B1222', raised: '#111A2E', line: '#1B2740', text: '#E8EEF9', muted: '#7D8BA6', accent: '#8DB8FF', up: '#3DDC84', down: '#FF5F6D' };
// Geist Mono embedded so the SVG renders the same inside a GitHub <img> (no external fonts there).
const MONO = readFileSync(join(root, 'src/fonts/geist-mono-400.woff2')).toString('base64');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Run the CLI as if on a colour terminal and capture its output. */
async function capture(argv, apiBase) {
  let out = '';
  const stdout = { isTTY: true, write: (s) => ((out += s), true) };
  const stderr = { write: () => true };
  const prev = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  await main([...argv, '--api', apiBase], { stdout, stderr, now: () => FIXTURE_TIME });
  if (prev !== undefined) process.env.NO_COLOR = prev;
  return out.replace(/\n+$/, '');
}

/** Convert ANSI-coloured lines into SVG <text> rows with <tspan> colours. */
function ansiToSvg(lines, { x, y, lh }) {
  const colorOf = { 31: C.down, 32: C.up, 33: C.accent, 36: C.accent };
  return lines
    .map((line, i) => {
      let fill = null;
      let bold = false;
      let dim = false;
      const spans = [];
      for (const part of line.split(/(\x1b\[\d+m)/)) {
        const m = part.match(/^\x1b\[(\d+)m$/);
        if (m) {
          const c = Number(m[1]);
          if (c === 0) [fill, bold, dim] = [null, false, false];
          else if (c === 1) bold = true;
          else if (c === 2) dim = true;
          else if (colorOf[c]) fill = colorOf[c];
          continue;
        }
        if (!part) continue;
        const color = fill || (dim ? C.muted : C.text);
        spans.push(`<tspan fill="${color}"${bold ? ' font-weight="700"' : ''}>${esc(part)}</tspan>`);
      }
      return `<text x="${x}" y="${y + i * lh}" xml:space="preserve">${spans.join('')}</text>`;
    })
    .join('\n');
}

function terminalSvg(command, output) {
  const lines = output.split('\n');
  const cw = 7.8;
  const lh = 20;
  const pad = 32;
  const longest = Math.max(command.length + 2, ...lines.map((l) => l.replace(/\x1b\[\d+m/g, '').length));
  const width = Math.ceil(longest * cw + pad * 2);
  const top = 92;
  const height = top + (lines.length + 1) * lh + 22;
  const prompt = `<text x="${pad}" y="${top}" xml:space="preserve"><tspan fill="${C.accent}">moons </tspan><tspan fill="${C.muted}">&#8250; </tspan><tspan fill="${C.text}">${esc(command.replace(/^moons /, ''))}</tspan></text>`;
  const title = 'example data, local mock API';
  const tw = title.length * 7.2 + 36;
  const stars = [[0.08, 0.3], [0.21, 0.82], [0.37, 0.12], [0.55, 0.9], [0.68, 0.22], [0.83, 0.64], [0.94, 0.08], [0.47, 0.5]]
    .map(([x, y], i) => `<circle cx="${(x * width).toFixed(1)}" cy="${(56 + y * (height - 70)).toFixed(1)}" r="${i % 2 ? 0.8 : 1.1}" fill="${C.accent}" fill-opacity=".22"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="moons terminal session (example data)">
<style>@font-face{font-family:"Geist Mono";src:url(data:font/woff2;base64,${MONO}) format("woff2")}text{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}</style>
<rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="20" fill="${C.bg}" stroke="${C.line}"/>
${stars}
<ellipse cx="${pad + 9}" cy="30" rx="11" ry="5" fill="none" stroke="${C.accent}" stroke-opacity=".5"/><circle cx="${pad + 9}" cy="30" r="4" fill="${C.accent}"/>
<text x="${pad + 28}" y="34.5" fill="${C.text}" style="font-size:13.5px">moons</text>
<rect x="${width - pad - tw}" y="16" width="${tw}" height="28" rx="14" fill="${C.raised}" stroke="${C.line}"/>
<text x="${width - pad - tw / 2}" y="34" text-anchor="middle" fill="${C.muted}" style="font-size:11.5px">${title}</text>
<line x1="${pad}" y1="60" x2="${width - pad}" y2="60" stroke="${C.line}"/>
${prompt}
${ansiToSvg(lines, { x: pad, y: top + lh, lh })}
</svg>
`;
}

/** Swap a marked block in a file: <!--name-->...<!--/name--> */
function splice(file, name, body) {
  const src = readFileSync(file, 'utf8');
  const a = `<!--${name}-->`;
  const b = `<!--/${name}-->`;
  const i = src.indexOf(a);
  const j = src.indexOf(b);
  if (i < 0 || j < 0) return;
  writeFileSync(file, src.slice(0, i + a.length) + body + src.slice(j));
}

/** ANSI output as HTML spans for the docs page terminal block. */
function ansiToHtml(text) {
  const cls = { 31: 'd', 32: 'u', 33: 'c', 36: 'c' };
  let open = 0;
  let html = '';
  for (const part of text.split(/(\x1b\[\d+m)/)) {
    const m = part.match(/^\x1b\[(\d+)m$/);
    if (!m) { html += esc(part).replace(/'/g, '&#39;'); continue; }
    const c = Number(m[1]);
    while (open) { html += '</span>'; open--; }
    if (c === 1) { html += '<span class="b">'; open++; } else if (c === 2) { html += '<span class="m">'; open++; } else if (cls[c]) { html += `<span class="${cls[c]}">`; open++; }
  }
  while (open) { html += '</span>'; open--; }
  return html;
}

const srv = await startMockServer();
try {
  const argv = [FIXTURE_MINT, '--limit', '6'];
  const out = await capture(argv, srv.url);
  writeFileSync(join(root, 'assets/terminal.svg'), terminalSvg(`moons ${argv.join(' ')}`, out));
  writeFileSync(join(root, 'assets/terminal.txt'), `$ moons ${argv.join(' ')}\n${out.replace(/\x1b\[\d+m/g, '')}\n`);

  const hub = await ecosystemReport(HUB_MINT, { apiBase: srv.url, now: FIXTURE_TIME });
  writeFileSync(join(root, 'assets/graph.svg'), renderGraphSvg(hub, { now: FIXTURE_TIME }));
  splice(join(root, 'docs/index.html'), 'GRAPH', renderGraphSvg(hub, { now: FIXTURE_TIME }).replace(/ width="960" height="720"/, ''));
  splice(join(root, 'docs/index.html'), 'TERM', `<span class="p">moons &#8250;</span> ${argv.join(' ')}\n${ansiToHtml(out)}`);

  const dir = process.argv[2];
  if (dir) {
    // The dashboard uses the wall clock, so serve fixtures with ages relative to now.
    const live = await startMockServer({ rebase: true });
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const d = await startDashboard({ port: 0, version, options: { apiBase: live.url, geckoBase: live.gecko } });
    const html = await (await fetch(`${d.url}/?mint=${HUB_MINT}`)).text();
    // Point the font routes at the files on disk so the saved page renders offline.
    writeFileSync(join(dir, 'dashboard.html'), html.replaceAll('url(/fonts/', `url(file://${root}src/fonts/`));
    await d.close();
    await live.close();
  }
  console.log('wrote assets/terminal.svg, assets/terminal.txt, assets/graph.svg, docs/index.html blocks');
} finally {
  await srv.close();
}
