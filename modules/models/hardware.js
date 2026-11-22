// Hardware scan with systeminformation, and the rules for which local model sizes fit.
import os from 'node:os';
import si from 'systeminformation';
import { OLLAMA_PICKS, UNSAFE_NAME } from './catalog.js';
const GiB = 1024 ** 3;

export async function scan() {
  // each part may fail on its own (a processor or graphics query on Windows on ARM, say) without losing the memory figures
  const [cpu, mem, gfx, osi] = await Promise.all([si.cpu().catch(() => ({})), si.mem().catch(() => null), si.graphics().catch(() => ({ controllers: [] })), si.osInfo().catch(() => ({}))]);
  const gpus = (gfx.controllers || []).map(c => {
    // On Windows the WMI figure caps at 4 GB; systeminformation also reads nvidia-smi (memoryTotal, MiB). Take the larger.
    const mib = Math.max(Number(c.vram) || 0, Number(c.memoryTotal) || 0);
    return { name: [c.vendor, c.model].filter(Boolean).join(' ').replace(/^NVIDIA Corporation /, 'NVIDIA ').trim() || c.name || 'Graphics', vramGb: Math.round(mib / 1024 * 10) / 10, dedicated: c.vramDynamic === false || /nvidia|amd|radeon/i.test(c.vendor + c.model) };
  }).filter(g => g.name);
  const best = gpus.filter(g => g.dedicated && g.vramGb >= 2).sort((a, b) => b.vramGb - a.vramGb)[0] || null;
  const m = readMemory(mem);
  return { at: new Date().toISOString(), cpu: { name: [cpu.manufacturer, cpu.brand].filter(Boolean).join(' '), cores: cpu.physicalCores || cpu.cores, threads: cpu.cores }, ...m, gpus, gpu: best, os: [osi.distro, osi.release].filter(Boolean).join(' '), ...recommend({ ramGb: m.ramGb, gpu: best }) };
}

/** The scan's memory figures (bytes) when they make sense; else the system's own count (os.totalmem, os.freemem), and which was used. */
export function readMemory(mem, sys = os) {
  const total = Number(mem?.total), avail = Number(mem?.available);
  const okTotal = Number.isFinite(total) && total >= GiB / 4 && total < 65536 * GiB;
  const okAvail = Number.isFinite(avail) && avail >= 0 && okTotal && avail <= total;
  const gb = (b) => Math.round(b / GiB * 10) / 10;
  if (okTotal && okAvail) return { ramGb: gb(total), ramFreeGb: gb(avail), memoryFrom: 'scan', memoryLine: null };
  const t = okTotal ? total : sys.totalmem(); const f = Math.min(sys.freemem(), t);
  return { ramGb: gb(t), ramFreeGb: gb(f), memoryFrom: 'system', memoryLine: 'Memory was read from the system\'s own count, because the hardware scan gave no usable figure.' };
}

/** Which local model sizes fit. Budget: 90% of graphics memory with a GPU, else 60% of RAM (slow on CPU). */
export function recommend({ ramGb, gpu }) {
  const onGpu = !!gpu;
  const budget = onGpu ? gpu.vramGb * 0.9 : ramGb * 0.6;
  const fits = (gb) => gb * 1.15 <= budget;   // leave room for the context
  const picks = OLLAMA_PICKS.filter(p => !UNSAFE_NAME.test(p.tag)).map((p, rank) => ({ ...p, rank, fits: fits(p.gb) }));
  const rawB = budget / 1.15 / 0.62;          // a 4-bit model takes about 0.62 GB per billion parameters
  const maxB = [70, 32, 14, 8, 4, 3, 1].find(b => b <= rawB) || 1;
  const line = onGpu
    ? `${gpu.name} with ${gpu.vramGb} GB of graphics memory: models up to about ${maxB}B parameters (4-bit) run inside the graphics card.`
    : `No graphics card the desk can use. On the processor with ${ramGb} GB of RAM, models up to about ${maxB}B run, slowly.`;
  return { budgetGb: Math.round(budget * 10) / 10, maxParamsB: maxB, line, picks: [...picks.filter(p => p.fits && !p.embed), ...picks.filter(p => p.embed), ...picks.filter(p => !p.fits && !p.embed)] };
}
