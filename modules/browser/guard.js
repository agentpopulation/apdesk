// Safety rules for the agent's browser. Pure functions, no browser.
// privateHost: which hosts are this PC or the home network. Sensitive field rules: which form fields the agent never fills.
import net from 'node:net';
import dns from 'node:dns';
import { siteRuleSync, siteRuleAsk } from '../network/rules.js';

export function privateHost(host) {
  host = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'host-gateway' || host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true;
  const kind = net.isIP(host);
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) {
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (dotted) return privateHost(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (hex) { const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16); return privateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    return host === '::' || host === '::1' || /^f[cd]/.test(host) || host.startsWith('fe80');
  }
  return false;
}

/**
 * The host to keep in the "Pages on your own network" list, read from what the owner typed ("printer.local",
 * "http://192.168.1.20:8080/", "[fd00::1]:80", "fd00::1"), the same way checkUrl reads a page address.
 * -> { host } or { error } with a plain reason.
 */
export function allowedHostOf(typed) {
  const s = String(typed || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (!s || (/^[/:?#]/.test(s) && net.isIP(s) !== 6)) return { error: 'Type an address, for example printer.local or 192.168.1.20.' };
  let host = '';
  if (net.isIP(s) === 6) host = s.toLowerCase();
  else { try { host = new URL('http://' + s).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { host = ''; } }
  if (net.isIP(host) === 6) { try { host = new URL('http://[' + host + ']/').hostname.replace(/^\[|\]$/g, ''); } catch {} }
  if (!host) return { error: 'That is not an address the desk can read. Type it like printer.local or 192.168.1.20.' };
  if (!privateHost(host)) return { error: `${host} is not on this PC or your home network, so it needs no allowing here.` };
  return { host };
}

/**
 * Is this address one the agent may open? Returns null when fine, else a plain sentence.
 * allowHosts: hosts the owner allowed (for example a LAN printer page). The desk's own port is refused
 * on every loopback name even when loopback is allowed, so an agent can never drive the desk itself.
 */
export function checkUrl(url, { allowHosts = [], deskPort = null, who = null, asking = false } = {}) {
  let u; try { u = new URL(String(url)); } catch { return 'That is not a web address.'; }
  if (u.href === 'about:blank') return null;
  if (!['http:', 'https:'].includes(u.protocol)) return `The agent's browser only opens web pages (http or https), not ${u.protocol.replace(':', '')} addresses.`;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const loop = host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host) || host === '0.0.0.0';
  if (loop && deskPort && String(port) === String(deskPort)) return 'The agent cannot open the desk itself.';
  if (privateHost(host) && !allowHosts.map(h => String(h).toLowerCase()).includes(host)) return `${host} is on this PC or your home network. The agent may open it only if you allow that address. Do it on any agent's Computer tab, under "Pages on your own network".`;
  try { siteRuleSync(host, { who, asking }); } catch (e) { return e.message; }   // the owner's website rules (Network page)
  return null;
}

/** The same check, plus a DNS look-up so a public name that points at this PC is refused too. Look-up errors pass (the proxy or the browser resolves). */
export async function checkUrlDeep(url, opts = {}) {
  const first = checkUrl(url, { ...opts, asking: true }); if (first) return first;
  let u; try { u = new URL(String(url)); } catch { return null; }
  if (u.href !== 'about:blank') { try { await siteRuleAsk(u.hostname, u.href, { who: opts.who }); } catch (e) { return e.message; } }   // "ask first": once per task
  if (u.href === 'about:blank' || net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) return null;
  if ((opts.allowHosts || []).includes(u.hostname.toLowerCase())) return null;
  try {
    const addrs = await Promise.race([dns.promises.lookup(u.hostname, { all: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 1500))]);
    // Behind a proxy that answers every name locally, opts.trustDns skips this refusal.
    const bad = addrs.find(a => privateHost(a.address));
    if (bad && !opts.trustDns) return `${u.hostname} points at ${bad.address}, which is on this PC or your home network.`;
  } catch {}
  return null;
}

const SENSITIVE_RULES = [
  { kind: 'password', test: (a) => a.type === 'password' || /current-password|new-password/.test(a.autocomplete) || /\b(pass(word|wd|code|phrase)?|pwd|m ?pin|atm pin|card pin|upi pin|security pin|transaction pin|login pin|t ?pin)\b/.test(a.words) },
  { kind: 'one_time_code', test: (a) => a.autocomplete === 'one-time-code' || /\b(otp|2fa|mfa|one ?time ?(pass(word)?|code)?|verification code|security code|totp|sms code|auth(entication)? code)\b/.test(a.words) },
  { kind: 'payment', test: (a) => /^cc-/.test(a.autocomplete) || /\b(card ?number|card ?no|cardnumber|cc ?(num|number|csc|exp|name)|cvv2?|cvc2?|csc|expiry|exp(iration)? date|valid thru|name on (the )?card|card ?holder|credit card|debit card|iban|ifsc|swift|bic|sort code|upi( ?(pin|id|address))?|vpa|account number|acct (no|number)|bank account|net ?banking|routing( number)?)\b/.test(a.words) },
];
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
/** 'password' | 'one_time_code' | 'payment' | null for one element row from the snapshot. */
export function sensitiveKind(row) {
  if (!row || typeof row !== 'object') return null;
  const tag = String(row.tag || '').toLowerCase(); const role = String(row.role || '').toLowerCase();
  if (!(['input', 'textarea', 'select'].includes(tag) || FIELD_ROLES.has(role) || row.editable)) return null;
  const words = [row.nameAttr, row.id, row.label, row.name, row.placeholder, row.autocomplete].filter(Boolean).join(' ').toLowerCase().replace(/[_-]+/g, ' ');
  const a = { type: String(row.type || '').toLowerCase(), autocomplete: String(row.autocomplete || '').toLowerCase(), words };
  for (const r of SENSITIVE_RULES) if (r.test(a)) return r.kind;
  return null;
}
export const SENSITIVE_WORDS = { password: 'a password field', one_time_code: 'a one-time code field', payment: 'a card or bank field' };

const PAY_WORDS = /\b(pay( now)?|buy now|place (your )?order|purchase|complete (the )?purchase|confirm (and )?pay(ment)?|submit payment|sign up|create (an )?account|log ?in|sign ?in)\b/i;
/** Buttons the agent never presses: pay, order, sign up, log in. The owner takes over instead. */
export function isOwnerOnlyButton(row) {
  if (!row) return false;
  const role = String(row.role || ''); if (!['button', 'link'].includes(role) && row.type !== 'submit') return false;
  return PAY_WORDS.test(String(row.name || ''));
}

export const OFFLINE_LINE = 'The desk is offline. Browsing needs the internet.';
/** Is this host this PC itself (the only place a browser may reach while the desk is Offline)? */
export function loopbackHost(host) {
  host = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host) || /^::ffff:(127\.|7f)/.test(host);
}
/** While Offline: true when this address would leave this PC. about:, data: and blob: never leave it. */
export function leavesThisPc(url) {
  let u; try { u = new URL(String(url)); } catch { return true; }
  if (['about:', 'data:', 'blob:'].includes(u.protocol)) return false;
  return !loopbackHost(u.hostname);
}
