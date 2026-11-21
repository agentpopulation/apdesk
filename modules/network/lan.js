// LAN helpers. ARP parsers: normalizeMac, parseProcNetArp, parseArpDashA.
// The probe is gentle: one TCP connect to 11434 (Ollama) and 8787 (a router) per address of this PC's own /24, nothing else.
import os from 'node:os';
import net from 'node:net';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const MAC_RE = /([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})/i;
const IPV4_RE = /\b((?:\d{1,3}\.){3}\d{1,3})\b/;
function normalizeMac(raw) {
  if (!raw) return null;
  const hex = String(raw).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || /^0+$/.test(hex) || /^f+$/.test(hex)) return null;
  return hex.match(/.{2}/g).join(':');
}
function isUsableIp(ip) {
  if (!ip || ip.startsWith('127.') || ip === '0.0.0.0' || ip === '255.255.255.255' || ip.startsWith('169.254.')) return false;
  const p = ip.split('.').map(Number); return p.length === 4 && p.every(n => Number.isFinite(n) && n >= 0 && n <= 255);
}
export function parseProcNetArp(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.toLowerCase().startsWith('ip address')) continue;
    const c = t.split(/\s+/); const mac = normalizeMac(c[3]);
    if (isUsableIp(c[0]) && mac) out.push({ ip: c[0], mac, iface: c[5] || null });
  }
  return out;
}
export function parseArpDashA(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim(); if (!t || /^Interface:/i.test(t) || /^Internet Address/i.test(t)) continue;
    const ipm = t.match(/\((\d{1,3}(?:\.\d{1,3}){3})\)/) || t.match(IPV4_RE); const macm = t.match(MAC_RE);
    if (!ipm || !macm) continue; const mac = normalizeMac(macm[1]);
    if (isUsableIp(ipm[1]) && mac) out.push({ ip: ipm[1], mac, iface: null });
  }
  return out;
}
export const isPrivate = (ip) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

/** This PC's own network interfaces (IPv4 and IPv6, not loopback). */
export function interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) for (const a of addrs || []) {
    if (a.internal) continue;
    out.push({ name, family: a.family === 4 ? 'IPv4' : a.family === 6 ? 'IPv6' : a.family, address: a.address, netmask: a.netmask, cidr: a.cidr, mac: a.mac && a.mac !== '00:00:00:00:00:00' ? a.mac : null, private: a.family === 'IPv4' || a.family === 4 ? isPrivate(a.address) : null });
  }
  return out;
}

export function arpTable({ timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && fs.existsSync('/proc/net/arp')) { try { return resolve({ source: '/proc/net/arp', devices: parseProcNetArp(fs.readFileSync('/proc/net/arp', 'utf8')) }); } catch {} }
    execFile('arp', ['-a'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? { source: 'arp -a', devices: [], error: err.code === 'ENOENT' ? 'arp is not available' : err.message } : { source: 'arp -a', devices: parseArpDashA(stdout) }));
  });
}

export function tcpOpen(host, port, { timeoutMs = 600, signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true)); s.once('error', () => done(false));
    signal?.addEventListener('abort', () => done(false), { once: true });
  });
}

/** Addresses of the /24 around each private IPv4 interface (at most two interfaces). */
export function subnetTargets(ifaces = interfaces()) {
  const nets = [...new Set(ifaces.filter(i => i.family === 'IPv4' && i.private).map(i => i.address.split('.').slice(0, 3).join('.')))].slice(0, 2);
  return { nets: nets.map(n => n + '.0/24'), hosts: nets.flatMap(n => Array.from({ length: 254 }, (_, k) => `${n}.${k + 1}`)), own: new Set(ifaces.map(i => i.address)) };
}

export async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

/** Is this IPv4 address inside one of this PC's own private subnets (by each adapter's own netmask)? */
const ip2n = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
export function inOwnSubnet(ip, ifaces = interfaces()) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip))) return false;
  return ifaces.some(i => i.family === 'IPv4' && i.private && i.netmask && ((ip2n(ip) & ip2n(i.netmask)) >>> 0) === ((ip2n(i.address) & ip2n(i.netmask)) >>> 0));
}
