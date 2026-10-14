// Network graph export: quote token in the centre, paired coins on rings,
// node size by 24h volume, edge width by estimated flow. Plain SVG + JS.
import { compactUsd, formatAge, formatChange } from './format.js';

export const COLORS = {
  bg: '#060A14',
  panel: '#0B1222',
  raised: '#111A2E',
  line: '#1B2740',
  accent: '#8DB8FF',
  secondary: '#3B5A8C',
  text: '#E8EEF9',
  muted: '#7D8BA6',
  up: '#3DDC84',
  down: '#FF5F6D',
};
export const MAX_NODES = 60;
const RINGS = [
  { r: 125, n: 8 },
  { r: 195, n: 14 },
  { r: 260, n: 18 },
  { r: 318, n: 20 },
];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const f1 = (n) => Math.round(n * 10) / 10;

/** Compute node positions. Biggest volume sits on the inner ring. */
export function layoutGraph(pairs, { width = 960, height = 720 } = {}) {
  const nodes = [...pairs].sort((a, b) => b.volume24h - a.volume24h).slice(0, MAX_NODES);
  const maxVol = Math.max(1, ...nodes.map((p) => p.volume24h));
  const maxFlow = Math.max(1, ...nodes.map((p) => p.flowUsd));
  const cx = width / 2;
  const cy = height / 2;
  let used = 0;
  for (let left = nodes.length; left > 0 && used < RINGS.length; used++) left -= RINGS[used].n;
  const rings = RINGS.slice(0, Math.max(1, used));
  // Scale the used rings to fill the canvas, so small ecosystems do not huddle in the centre.
  const outer = RINGS.at(-1).r * (0.62 + 0.38 * (rings.length / RINGS.length));
  const k = outer / rings.at(-1).r;
  const sx = Math.min(1.35, (width / 2 - 40) / RINGS.at(-1).r) * k;
  const sy = Math.min(1, (height / 2 - 30) / RINGS.at(-1).r) * k;
  const out = [];
  let i = 0;
  rings.forEach((ring, ri) => {
    const count = Math.min(ring.n, nodes.length - i);
    for (let j = 0; j < count; j++, i++) {
      const a = -Math.PI / 2 + (2 * Math.PI * j) / count + ri * 0.37;
      const p = nodes[i];
      out.push({
        pair: p,
        x: f1(cx + ring.r * sx * Math.cos(a)),
        y: f1(cy + ring.r * sy * Math.sin(a)),
        r: f1(6 + 24 * Math.sqrt(p.volume24h / maxVol)),
        w: f1(0.8 + 5 * (p.flowUsd / maxFlow)),
      });
    }
  });
  const guides = rings.map((r) => ({ rx: f1(r.r * sx), ry: f1(r.r * sy) }));
  return { cx, cy, nodes: out, guides, hidden: pairs.length - out.length };
}

/** Line from the centre disc edge to the node edge. */
function edgeLine(cx, cy, n, inner = 48) {
  const dx = n.x - cx;
  const dy = n.y - cy;
  const d = Math.hypot(dx, dy) || 1;
  const a = Math.min(inner, d);
  const b = Math.max(a, d - n.r - 2);
  return [f1(cx + (dx * a) / d), f1(cy + (dy * a) / d), f1(cx + (dx * b) / d), f1(cy + (dy * b) / d)];
}

/** Render the graph as a standalone SVG string. */
export function renderGraphSvg(report, { width = 960, height = 720, now = Date.now(), legend = true } = {}) {
  const C = COLORS;
  const { cx, cy, nodes, guides, hidden } = layoutGraph(report.pairs, { width, height });
  const qsym = report.quote?.symbol || 'QUOTE';
  const edges = [];
  const dots = [];
  for (const [i, n] of nodes.entries()) {
    const p = n.pair;
    const fresh = p.createdAt != null && now - p.createdAt <= 86400e3;
    const tone = p.change24h == null ? C.muted : p.change24h >= 0 ? C.up : C.down;
    const [x1, y1, x2, y2] = edgeLine(cx, cy, n);
    edges.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${fresh ? C.accent : C.secondary}" stroke-opacity="${fresh ? 0.75 : 0.38}" stroke-width="${n.w}"${fresh ? ' stroke-dasharray="4 4"' : ''}/>`);
    const tip = [
      `${p.baseSymbol}/${p.quoteSymbol} on ${p.dexId}`,
      `Vol 24h ${compactUsd(p.volume24h)}, flow est. ${compactUsd(p.flowUsd)}`,
      `Liq ${compactUsd(p.liquidityUsd)}, mcap ${compactUsd(p.marketCap)}`,
      `${p.buys24h} buys / ${p.sells24h} sells, ${formatChange(p.change24h)}, age ${formatAge(p.createdAt, now)}`,
    ].join('\n');
    const label = n.r >= 11 || i < 16
      ? `<text x="${n.x}" y="${f1(n.y + n.r + 13)}" text-anchor="middle" class="mn-l">${esc(p.baseSymbol.slice(0, 12))}</text>`
      : '';
    dots.push(
      `<g class="mn-n" data-url="${esc(p.url || '')}" data-tip="${esc(tip)}" tabindex="0">` +
        (fresh ? `<circle cx="${n.x}" cy="${n.y}" r="${f1(n.r + 4)}" fill="none" stroke="${C.accent}" stroke-width="1.5"/>` : '') +
        `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${tone}" fill-opacity="0.18" stroke="${tone}" stroke-width="1.6"/>` +
        `<title>${esc(tip)}</title>${label}</g>`,
    );
  }
  const center =
    `<g class="mn-c"><circle cx="${cx}" cy="${cy}" r="56" fill="none" stroke="${C.accent}" stroke-opacity="0.22" stroke-width="1"/>` +
    `<circle cx="${cx}" cy="${cy}" r="44" fill="${C.raised}" stroke="${C.accent}" stroke-width="2.5"/>` +
    `<text x="${cx}" y="${cy - 3}" text-anchor="middle" class="mn-q">${esc(qsym.slice(0, 8))}</text>` +
    `<text x="${cx}" y="${cy + 15}" text-anchor="middle" class="mn-s">${report.pairs.length} pairs</text></g>`;
  const legendSvg = legend
    ? `<g class="mn-s" transform="translate(20 ${height - 70})">` +
      `<circle cx="7" cy="0" r="6" fill="${C.up}" fill-opacity="0.18" stroke="${C.up}"/><text x="20" y="4">size = 24h volume, green/red = 24h change</text>` +
      `<line x1="0" y1="20" x2="14" y2="20" stroke="${C.secondary}" stroke-width="3"/><text x="20" y="24">edge width = est. flow into ${esc(qsym)}</text>` +
      `<circle cx="7" cy="40" r="6" fill="none" stroke="${C.accent}" stroke-width="1.5"/><text x="20" y="44">ring = pair created in the last 24h</text></g>`
    : '';
  const more = hidden > 0 ? `<text x="${width - 20}" y="${height - 26}" text-anchor="end" class="mn-s">+${hidden} smaller pairs not drawn</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="mn-graph" role="img" aria-label="Pair network for ${esc(qsym)}">
<style>.mn-graph{font-family:Geist,Inter,system-ui,sans-serif}.mn-l{fill:${C.text};font-size:11px;font-weight:600}.mn-q{fill:${C.text};font-size:15px;font-weight:600;letter-spacing:-.02em}.mn-s{fill:${C.muted};font-size:11px}.mn-n{cursor:pointer}.mn-n:hover circle,.mn-n:focus circle{stroke-width:2.6;fill-opacity:.35}</style>
<defs><pattern id="mn-stars" width="46" height="46" patternUnits="userSpaceOnUse"><circle cx="6" cy="9" r=".8" fill="#8DB8FF" fill-opacity=".22"/><circle cx="31" cy="27" r=".6" fill="#E8EEF9" fill-opacity=".18"/><circle cx="18" cy="40" r=".5" fill="#8DB8FF" fill-opacity=".14"/></pattern></defs>
<rect width="${width}" height="${height}" fill="${C.bg}"/><rect width="${width}" height="${height}" fill="url(#mn-stars)"/>
${guides.map((g) => `<ellipse cx="${cx}" cy="${cy}" rx="${g.rx}" ry="${g.ry}" fill="none" stroke="${C.accent}" stroke-opacity="0.13" stroke-width="1"/>`).join('')}
${edges.join('\n')}
${center}
${dots.join('\n')}
${legendSvg}${more}
</svg>`;
}

/** Inline script that adds tooltips, click-through, wheel zoom and drag pan to any .mn-graph. */
export const GRAPH_SCRIPT = `(function(){
function wire(svg){if(svg.__mn)return;svg.__mn=1;var host=svg.parentNode;host.style.position='relative';
var tip=document.createElement('div');tip.className='mn-tip';host.appendChild(tip);
var vb=svg.viewBox.baseVal,base={x:vb.x,y:vb.y,w:vb.width,h:vb.height},drag=null;
svg.querySelectorAll('.mn-n').forEach(function(g){var t=g.querySelector('title');if(t)t.remove();
g.addEventListener('mousemove',function(e){var r=host.getBoundingClientRect();tip.textContent=g.dataset.tip;tip.style.display='block';
tip.style.left=Math.min(e.clientX-r.left+14,r.width-260)+'px';tip.style.top=(e.clientY-r.top+14)+'px'});
g.addEventListener('mouseleave',function(){tip.style.display='none'});
g.addEventListener('click',function(){if(!drag||!drag.moved){var u=g.dataset.url;if(u)window.open(u,'_blank','noopener')}})});
svg.addEventListener('wheel',function(e){e.preventDefault();var k=e.deltaY>0?1.12:1/1.12,r=svg.getBoundingClientRect();
var px=vb.x+(e.clientX-r.left)/r.width*vb.width,py=vb.y+(e.clientY-r.top)/r.height*vb.height;
var w=Math.min(base.w*2,Math.max(base.w/6,vb.width*k)),h=w*base.h/base.w;vb.x=px-(px-vb.x)*w/vb.width;vb.y=py-(py-vb.y)*h/vb.height;vb.width=w;vb.height=h},{passive:false});
svg.addEventListener('mousedown',function(e){drag={x:e.clientX,y:e.clientY,vx:vb.x,vy:vb.y,moved:false}});
window.addEventListener('mousemove',function(e){if(!drag)return;var r=svg.getBoundingClientRect(),dx=e.clientX-drag.x,dy=e.clientY-drag.y;
if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;vb.x=drag.vx-dx*vb.width/r.width;vb.y=drag.vy-dy*vb.height/r.height});
window.addEventListener('mouseup',function(){setTimeout(function(){drag=null},0)});
svg.addEventListener('dblclick',function(){vb.x=base.x;vb.y=base.y;vb.width=base.w;vb.height=base.h})}
window.moonsGraph=function(root){(root||document).querySelectorAll('svg.mn-graph').forEach(wire)};
window.moonsGraph();})();`;

export const GRAPH_TIP_CSS = `.mn-tip{position:absolute;display:none;pointer-events:none;white-space:pre;background:#111A2E;color:#E8EEF9;border:1px solid rgba(141,184,255,.35);border-radius:14px;padding:9px 12px;font:12px/1.5 "Geist Mono",ui-monospace,monospace;z-index:5;box-shadow:0 12px 32px rgba(2,5,12,.6)}`;

/** Self-contained interactive HTML page around the SVG. */
export function renderGraphHtml(report, opts = {}) {
  const now = opts.now ?? Date.now();
  const q = report.quote?.symbol || report.mint;
  const m = report.metrics;
  const stats = m
    ? `${m.totalPairs} pairs, volume ${compactUsd(m.volume24h)}, est. flow into ${esc(q)} ${compactUsd(m.flowUsd)}, health ${report.health.score}/100`
    : `${report.pairs.length} pairs`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(q)} moons, pair network</title>
<style>body{margin:0;background:${COLORS.bg};color:${COLORS.text};font-family:Geist,Inter,system-ui,sans-serif}
header{padding:20px 24px 8px}h1{font-size:20px;margin:0 0 4px}p{margin:0;color:${COLORS.muted};font-size:13px}
code{font-family:"Geist Mono",ui-monospace,monospace;font-size:12px}
.wrap{padding:8px 24px 24px}.wrap svg{width:100%;height:auto;max-height:86vh;border:1px solid ${COLORS.line};border-radius:20px;display:block}
${GRAPH_TIP_CSS}</style></head><body>
<header><h1>${esc(q)} pair network</h1><p>${stats}. Snapshot ${new Date(report.fetchedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC. Quote <code>${esc(report.mint)}</code> on ${esc(report.chain)}. Scroll to zoom, drag to pan, double click to reset, click a node to open it on DexScreener. Flow is an estimate.</p></header>
<div class="wrap">${renderGraphSvg(report, { now })}</div>
<script>${GRAPH_SCRIPT}</script>
</body></html>
`;
}
