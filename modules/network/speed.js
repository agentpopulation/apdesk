// Speed test through the desk's ctx.fetch
// (aborted by Panic). About 26 MB per run against speed.cloudflare.com; only numbers and the time are kept.
// runLatency: several tiny timed requests (no download) for latency, jitter and loss.
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
  const lat = await runLatency(fetch, { rounds: PING_ROUNDS * 2 });
  const { pingMs, jitterMs, lossPct } = lat; const colo = lat.colo;
  if (pingMs == null) throw Object.assign(new Error('The speed server did not answer.'), { status: 502 });
  onProgress(0.15, 'Download');
  let downMbps = null, bytesDown = 0;
  for (let i = 0; i < DOWN_ROUNDS; i++) { const { ms, bytes } = await timed(`${base}/__down?bytes=${DOWN_BYTES}`); bytesDown += bytes; const r = mbps(bytes, ms); if (r != null && (downMbps == null || r > downMbps)) downMbps = r; onProgress(0.15 + 0.4 * (i + 1) / DOWN_ROUNDS, 'Download'); }
  let upMbps = null, bytesUp = 0; const payload = new Uint8Array(UP_BYTES).fill(0x61);
  for (let i = 0; i < UP_ROUNDS; i++) { const { ms } = await timed(`${base}/__up`, { method: 'POST', body: payload, headers: { 'content-type': 'application/octet-stream' } }); bytesUp += payload.length; const r = mbps(payload.length, ms); if (r != null && (upMbps == null || r > upMbps)) upMbps = r; onProgress(0.55 + 0.45 * (i + 1) / UP_ROUNDS, 'Upload'); }
  return { at: new Date().toISOString(), kind: 'full', server: SPEEDTEST_HOST + (colo ? ` (Cloudflare ${colo})` : ''), pingMs, jitterMs, lossPct, downMbps, upMbps, bytesDown, bytesUp };
}

/** What one full test moves, in bytes (download plus upload); the latency rounds are a few kilobytes. */
export const FULL_TEST_BYTES = DOWN_BYTES * DOWN_ROUNDS + UP_BYTES * UP_ROUNDS;
export const LATENCY_TEST_BYTES = 20_000;

/**
 * rounds tiny requests (bytes=0) after one warm-up; a request that fails or takes longer than timeoutMs is lost.
 * -> { pingMs (median), jitterMs (mean change between rounds), lossPct, sent, lost, colo }
 */
export async function runLatency(fetch, { rounds = 10, timeoutMs = 3000, pauseMs = 120 } = {}) {
  const base = `https://${SPEEDTEST_HOST}`;
  const times = []; let lost = 0; let colo = null;
  for (let i = 0; i <= rounds; i++) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), timeoutMs);
    const t0 = performance.now();
    try {
      const res = await fetch(`${base}/__down?bytes=0`, { signal: ac.signal, headers: { 'cache-control': 'no-store' } });
      await res.arrayBuffer();
      if (!res.ok) throw new Error(String(res.status));
      colo = colo || res.headers.get('cf-meta-colo') || (res.headers.get('cf-ray') || '').split('-')[1] || null;
      if (i > 0) times.push(Math.round(performance.now() - t0));
    } catch (e) {
      if (e?.code === 'offline' || e?.code === 'halted') throw e;
      if (i > 0) lost++;
    } finally { clearTimeout(t); }
    if (pauseMs && i < rounds) await new Promise(r => setTimeout(r, pauseMs));
  }
  const jitterMs = times.length > 1 ? Math.round(times.slice(1).reduce((s, v, i) => s + Math.abs(v - times[i]), 0) / (times.length - 1)) : null;
  return { at: new Date().toISOString(), kind: 'latency', server: SPEEDTEST_HOST + (colo ? ` (Cloudflare ${colo})` : ''), pingMs: median(times), jitterMs, lossPct: rounds ? Math.round(lost / rounds * 1000) / 10 : 0, sent: rounds, lost, colo };
}
