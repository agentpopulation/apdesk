// Speed test through the desk's ctx.fetch
// (aborted by Panic). About 26 MB per run against speed.cloudflare.com; only numbers and the time are kept.
export const SPEEDTEST_HOST = 'speed.cloudflare.com';
const PING_ROUNDS = 5, DOWN_BYTES = 10_000_000, DOWN_ROUNDS = 2, UP_BYTES = 3_000_000, UP_ROUNDS = 2;
const mbps = (bytes, ms) => (ms > 0 ? Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 10) / 10 : null);
const median = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

export async function runSpeedTest(fetch, { onProgress = () => {} } = {}) {
  const base = `https://${SPEEDTEST_HOST}`;
  const timed = async (url, init) => {
    const t0 = performance.now();
    const res = await fetch(url, init);
    if (!res.ok) throw Object.assign(new Error(`The speed server answered ${res.status}.`), { status: 502 });
    const buf = await res.arrayBuffer();
    return { ms: performance.now() - t0, bytes: buf.byteLength, colo: res.headers.get('cf-meta-colo') || (res.headers.get('cf-ray') || '').split('-')[1] || null };
  };
  const pings = []; let colo = null;
  for (let i = 0; i <= PING_ROUNDS; i++) { const r = await timed(`${base}/__down?bytes=0`); colo = colo || r.colo; if (i > 0) pings.push(Math.round(r.ms)); }
  onProgress(0.15, 'Download');
  const pingMs = median(pings);
  const jitterMs = pings.length > 1 ? Math.round(pings.slice(1).reduce((s, v, i) => s + Math.abs(v - pings[i]), 0) / (pings.length - 1)) : null;
  let downMbps = null, bytesDown = 0;
  for (let i = 0; i < DOWN_ROUNDS; i++) { const { ms, bytes } = await timed(`${base}/__down?bytes=${DOWN_BYTES}`); bytesDown += bytes; const r = mbps(bytes, ms); if (r != null && (downMbps == null || r > downMbps)) downMbps = r; onProgress(0.15 + 0.4 * (i + 1) / DOWN_ROUNDS, 'Download'); }
  let upMbps = null, bytesUp = 0; const payload = new Uint8Array(UP_BYTES).fill(0x61);
  for (let i = 0; i < UP_ROUNDS; i++) { const { ms } = await timed(`${base}/__up`, { method: 'POST', body: payload, headers: { 'content-type': 'application/octet-stream' } }); bytesUp += payload.length; const r = mbps(payload.length, ms); if (r != null && (upMbps == null || r > upMbps)) upMbps = r; onProgress(0.55 + 0.45 * (i + 1) / UP_ROUNDS, 'Upload'); }
  return { at: new Date().toISOString(), server: SPEEDTEST_HOST + (colo ? ` (Cloudflare ${colo})` : ''), pingMs, jitterMs, downMbps, upMbps, bytesDown, bytesUp };
}
