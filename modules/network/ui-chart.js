// Small charts for the Network page, drawn as inline SVG by our own code (no chart library).
// lineModel / barModel are pure (tested in node); drawLine / drawBars turn a model into SVG elements in the page.
// Colours come from the shell's CSS variables, so both themes read well. Every chart has a text table beside it.

const niceStep = (span, n) => { const raw = span / Math.max(1, n); const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
const round = (v) => Math.round(v * 10) / 10;

/**
 * series: [{ name, points: [{ t: ms since epoch, v: number|null }] }]. Returns geometry only.
 * One point: drawn as a dot in the middle with an hour either side. Many points: lines only (dots up to 40 points).
 */
export function lineModel(series, { width = 640, height = 200, pad = { l: 46, r: 12, t: 12, b: 28 }, xTicks = 5, yTicks = 4, timeLabel = (t) => new Date(t).toISOString().slice(11, 16), valueLabel = (v) => String(v) } = {}) {
  const pts = series.flatMap(s => s.points.filter(p => Number.isFinite(p.t) && Number.isFinite(p.v)));
  const out = { width, height, pad, x: [], y: [], lines: [], empty: pts.length === 0, count: pts.length };
  if (!pts.length) return out;
  let t0 = Math.min(...pts.map(p => p.t)), t1 = Math.max(...pts.map(p => p.t));
  if (t1 - t0 < 60_000) { t0 -= 3600_000; t1 += 3600_000; }
  const vmax = Math.max(...pts.map(p => p.v), 0);
  const step = niceStep(vmax || 1, yTicks); const top = Math.max(step, Math.ceil((vmax || 1) / step) * step);
  const ticks = []; for (let v = 0; v <= top + 1e-9; v += step) ticks.push({ v, label: valueLabel(round(v)) });
  pad = { ...pad, l: Math.max(pad.l, Math.ceil(Math.max(...ticks.map(t => String(t.label).length)) * 6.6 + 12)) };   // room for the longest y label
  out.pad = pad;
  const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
  const X = (t) => round(pad.l + (t - t0) / (t1 - t0) * iw);
  const Y = (v) => round(pad.t + ih - (v / top) * ih);
  for (const t of ticks) out.y.push({ y: Y(t.v), label: t.label });
  const nx = Math.max(2, Math.min(xTicks, Math.floor(iw / 90)));
  for (let i = 0; i < nx; i++) { const t = t0 + (t1 - t0) * (i / (nx - 1)); out.x.push({ x: X(t), label: timeLabel(t) }); }
  const many = pts.length > 40;
  out.lines = series.map((s, k) => {
    const ok = s.points.filter(p => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
    const xy = ok.map(p => [X(p.t), Y(p.v)]);
    return { name: s.name, k, d: xy.length > 1 ? 'M' + xy.map(p => p.join(',')).join(' L') : '', dots: many ? [] : xy.map(([x, y]) => ({ x, y })), last: ok.length ? ok[ok.length - 1].v : null };
  });
  return out;
}

/** rows: [{ label, v }] -> horizontal bars. */
export function barModel(rows, { width = 520, rowH = 26, labelW = 150, pad = 8, valueLabel = (v) => String(v) } = {}) {
  const ok = rows.filter(r => Number.isFinite(r.v));
  const max = Math.max(1, ...ok.map(r => r.v));
  const iw = width - labelW - pad * 2 - 64;
  return { width, height: Math.max(rowH, ok.length * rowH) + pad, bars: ok.map((r, i) => ({ label: String(r.label).slice(0, 28), y: pad / 2 + i * rowH, x: labelW, w: Math.max(2, round(r.v / max * iw)), h: rowH - 8, text: valueLabel(r.v) })) };
}

const NS = 'http://www.w3.org/2000/svg';
const COLORS = ['var(--accent)', 'var(--ok)', 'var(--warn)', 'var(--stop)'];
function el(doc, tag, attrs = {}, text) { const e = doc.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text != null) e.textContent = String(text); return e; }

/** The model as an <svg> element. title is read by screen readers; the table under the chart carries the numbers. */
export function drawLine(doc, model, { title = 'Chart', names = [] } = {}) {
  const svg = el(doc, 'svg', { viewBox: `0 0 ${model.width} ${model.height}`, width: model.width, height: model.height, role: 'img', 'aria-label': title, style: 'display:block;max-width:100%;height:auto' });
  svg.append(el(doc, 'title', {}, title));
  const { pad, width, height } = model;
  if (model.empty) { svg.append(el(doc, 'text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', fill: 'var(--dim)', 'font-size': 12 }, 'No numbers yet')); return svg; }
  for (const t of model.y) {
    svg.append(el(doc, 'line', { x1: pad.l, x2: width - pad.r, y1: t.y, y2: t.y, stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(el(doc, 'text', { x: pad.l - 6, y: t.y + 4, 'text-anchor': 'end', fill: 'var(--dim)', 'font-size': 11 }, t.label));
  }
  model.x.forEach((t, i) => svg.append(el(doc, 'text', { x: t.x, y: height - 8, 'text-anchor': i === 0 ? 'start' : i === model.x.length - 1 ? 'end' : 'middle', fill: 'var(--dim)', 'font-size': 11 }, t.label)));
  for (const l of model.lines) {
    const c = COLORS[l.k % COLORS.length];
    if (l.d) svg.append(el(doc, 'path', { d: l.d, fill: 'none', stroke: c, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    for (const p of l.dots) svg.append(el(doc, 'circle', { cx: p.x, cy: p.y, r: 3.5, fill: c }));
  }
  return svg;
}
export function legend(doc, names) {
  const box = doc.createElement('div'); box.className = 'netp-legend';
  names.forEach((n, k) => { const s = doc.createElement('span'); const sw = doc.createElement('i'); sw.style.background = COLORS[k % COLORS.length]; s.append(sw, doc.createTextNode(n)); box.append(s); });
  return box;
}
export function drawBars(doc, model, { title = 'Chart' } = {}) {
  const svg = el(doc, 'svg', { viewBox: `0 0 ${model.width} ${model.height}`, width: model.width, height: model.height, role: 'img', 'aria-label': title, style: 'display:block;max-width:100%;height:auto' });
  svg.append(el(doc, 'title', {}, title));
  for (const b of model.bars) {
    svg.append(el(doc, 'text', { x: b.x - 8, y: b.y + b.h / 2 + 4, 'text-anchor': 'end', fill: 'var(--fg)', 'font-size': 12 }, b.label));
    svg.append(el(doc, 'rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 3, fill: 'var(--accent)' }));
    svg.append(el(doc, 'text', { x: b.x + b.w + 6, y: b.y + b.h / 2 + 4, fill: 'var(--dim)', 'font-size': 11.5 }, b.text));
  }
  return svg;
}
