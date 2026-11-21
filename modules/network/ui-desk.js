// The Desk view of the Network page: an agent map and the agent-to-provider picture, drawn as inline SVG by our own
// code (no library). Text from the desk is set as text nodes only. Every picture has a plain table beside it.
import { layoutDeps, related } from './ui-deskmap.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (doc, tag, attrs = {}, text) => { const e = doc.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text != null) e.textContent = String(text); return e; };
const short = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
export const STATE = { working: ['Working', 'var(--ok)'], waiting: ['Waiting for you', 'var(--warn)'], idle: ['Idle', 'var(--dim)'], failed: ['Failed', 'var(--stop)'] };

/** One node per agent, coloured by state, with what it is doing. No lines: the desk holds no data for agent-to-agent links. */
export function drawAgentMap(doc, states, { width = 640 } = {}) {
  const cellW = 170, cellH = 62, cols = Math.max(1, Math.floor(width / cellW)), rows = Math.max(1, Math.ceil(states.length / cols));
  const svg = svgEl(doc, 'svg', { viewBox: `0 0 ${width} ${rows * cellH}`, width, height: rows * cellH, role: 'img', 'aria-label': 'Agents and what each is doing', style: 'display:block;max-width:100%;height:auto' });
  svg.append(svgEl(doc, 'title', {}, 'Agents and what each is doing'));
  states.forEach((s, i) => {
    const x = (i % cols) * cellW + 14, y = Math.floor(i / cols) * cellH, [word, colour] = STATE[s.state] || STATE.idle;
    const g = svgEl(doc, 'g', { 'data-agent': s.id });
    g.append(svgEl(doc, 'title', {}, `${s.name}: ${word}${s.doing ? '. ' + s.doing : ''}`),
      svgEl(doc, 'circle', { cx: x, cy: y + 20, r: 9, fill: colour }),
      svgEl(doc, 'text', { x: x + 18, y: y + 24, fill: 'var(--fg)', 'font-size': 13, 'font-weight': 600 }, short(s.name, 16)),
      svgEl(doc, 'text', { x: x + 18, y: y + 40, fill: colour, 'font-size': 11.5 }, word),
      svgEl(doc, 'text', { x: x + 18, y: y + 54, fill: 'var(--dim)', 'font-size': 11 }, s.doing ? short(s.doing, 24) : ''));
    svg.append(g);
  });
  return svg;
}

/** Agents left, providers right, line weight = calls in the last 24 hours. Choosing a provider marks its callers. */
export function drawDeps(doc, model, { width = 640, sel = null, onSelect = () => {} } = {}) {
  const g = layoutDeps(model, { width }), rel = related(model, sel), marked = !!(sel && (rel.agents.size || rel.providers.size));
  const svg = svgEl(doc, 'svg', { viewBox: `0 0 ${g.width} ${g.height}`, width: g.width, height: g.height, role: 'img', 'aria-label': 'Which agents called which providers in the last 24 hours', style: 'display:block;max-width:100%;height:auto' });
  svg.append(svgEl(doc, 'title', {}, 'Which agents called which providers in the last 24 hours'));
  const dim = (on) => (marked && !on ? 0.3 : 1);
  for (const l of g.lines) {
    const on = rel.agents.has(l.agentId) && rel.providers.has(l.provider);
    svg.append(svgEl(doc, 'line', { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, stroke: l.down ? 'var(--stop)' : 'var(--accent)', 'stroke-width': l.w, 'stroke-linecap': 'round', opacity: marked ? (on ? 0.9 : 0.12) : 0.45 }, null));
  }
  for (const a of g.agents) {
    const on = rel.agents.has(a.id);
    const n = svgEl(doc, 'g', { 'data-agent': a.id, opacity: dim(on) });
    n.append(svgEl(doc, 'circle', { cx: a.x, cy: a.y, r: 8, fill: 'var(--bubble)', stroke: a.affected ? 'var(--stop)' : 'var(--fg)', 'stroke-width': a.affected || on ? 3 : 1.5 }),
      svgEl(doc, 'text', { x: a.x - 14, y: a.y + 4, 'text-anchor': 'end', fill: 'var(--fg)', 'font-size': 12 }, short(a.name, 14) + (a.affected ? ' !' : '')));
    n.firstChild.before(svgEl(doc, 'title', {}, a.name + (a.affected ? ': used a provider whose last check failed' : '')));
    svg.append(n);
  }
  for (const p of g.providers) {
    const on = rel.providers.has(p.provider);
    const n = svgEl(doc, 'g', { 'data-provider': p.provider, opacity: dim(on), tabindex: 0, role: 'button', style: 'cursor:pointer', 'aria-pressed': String(on), 'aria-label': `${p.label}, ${p.calls} calls${p.down ? ', last check failed' : ''}` });
    n.append(svgEl(doc, 'title', {}, p.label),
      svgEl(doc, 'circle', { cx: p.x, cy: p.y, r: 8, fill: p.down ? 'var(--stop)' : 'var(--bubble)', stroke: p.down ? 'var(--stop)' : 'var(--fg)', 'stroke-width': on ? 3 : 1.5 }),
      svgEl(doc, 'text', { x: p.x + 14, y: p.y + 4, fill: p.down ? 'var(--stop)' : 'var(--fg)', 'font-size': 12 }, short(p.label, 14) + (p.down ? ' (check failed)' : '')));
    const pick = () => onSelect(on ? null : { kind: 'provider', key: p.provider });
    n.addEventListener('click', pick); n.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    svg.append(n);
  }
  return svg;
}
