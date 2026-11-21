// Website rules for the agents: sites they may never open, and sites they may open only after asking the owner.
// The Network module sets the lists (from the owner's own page only); the address guards in modules/search/guard.js
// and modules/browser/guard.js read them through siteRuleSync / siteRuleAsk. Pure state in this process, no I/O.
import { AsyncLocalStorage } from 'node:async_hooks';
import net from 'node:net';

// Two-part public suffixes, so "news.example.co.uk" is ruled as "example.co.uk", not "co.uk".
// A short list, not the full Public Suffix List: a name under a suffix missing here is ruled by its last two labels.
const TWO_PART = new Set(('co.uk org.uk ac.uk gov.uk ltd.uk plc.uk me.uk net.uk nhs.uk police.uk sch.uk ' +
  'com.au net.au org.au edu.au gov.au asn.au id.au co.nz net.nz org.nz govt.nz ac.nz ' +
  'co.in net.in org.in gen.in firm.in ind.in ac.in edu.in res.in gov.in nic.in mil.in ' +
  'co.jp ne.jp or.jp ac.jp go.jp com.br net.br org.br gov.br com.cn net.cn org.cn gov.cn edu.cn ' +
  'com.sg edu.sg gov.sg com.my com.hk com.tw co.kr co.za org.za gov.za co.il ac.il com.mx com.ar com.tr com.sa com.eg ' +
  'com.pk com.bd com.ng co.ke com.ph com.vn co.id co.th ' +
  'github.io gitlab.io pages.dev workers.dev netlify.app vercel.app herokuapp.com blogspot.com web.app firebaseapp.com azurewebsites.net cloudfront.net appspot.com').split(/\s+/));

/** A host as the rules compare it: lower case, no brackets, no trailing dots. */
export function cleanHost(host) { return String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, ''); }

/** The registrable domain of a host: "www.news.example.co.uk" -> "example.co.uk". An IP address stays itself. */
export function registrable(host) {
  const h = cleanHost(host);
  if (!h || net.isIP(h)) return h;
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return TWO_PART.has(last2) ? parts.slice(-3).join('.') : last2;
}

/** What the owner typed (a domain or an address) -> the domain a rule covers, or throws a plain sentence. */
export function ruleDomain(entry) {
  let s = String(entry || '').trim();
  if (!s) throw Object.assign(new Error('Type a site, for example example.com.'), { status: 400 });
  if (s.length > 300) throw Object.assign(new Error('That is too long for a site name.'), { status: 400 });
  let host;
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s).hostname; } catch { throw Object.assign(new Error('That is not a site name.'), { status: 400 }); }
  host = cleanHost(host);
  if (!host || (!net.isIP(host) && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(host))) throw Object.assign(new Error('That is not a site name.'), { status: 400 });
  const d = registrable(host);
  if (!net.isIP(d) && !d.includes('.')) throw Object.assign(new Error('Give a whole site name, for example example.com.'), { status: 400 });
  return d;
}
/** One plain sentence about exactly what a rule on this domain covers. */
export function covers(domain) {
  if (net.isIP(domain)) return `Only the address ${domain} itself. It does not cover any site name.`;
  return `${domain} and every name under it (for example www.${domain}). Not other endings such as ${domain.split('.')[0]}.org, and not the site's numeric address.`;
}

const state = { never: [], ask: [], version: 0, asker: null, decisions: new Map(), pending: new Map() };
const DECISION_MS = 15 * 60_000;   // like the approval door's grants: a turn's yes or no lasts at most 15 minutes

/** Called by the Network module only: the lists it keeps in its own settings. */
export function setRules({ never = [], ask = [] } = {}) {
  state.never = [...new Set(never.map(cleanHost).filter(Boolean))];
  state.ask = [...new Set(ask.map(cleanHost).filter(Boolean))].filter(d => !state.never.includes(d));
  state.version++;
  state.decisions.clear();
}
export function setAsker(fn) { state.asker = typeof fn === 'function' ? fn : null; }
export function clearRules() { setRules({}); state.asker = null; }
export const rulesVersion = () => state.version;
export const listRules = () => ({ never: [...state.never], ask: [...state.ask] });

const under = (host, d) => host === d || host.endsWith('.' + d);
/** { kind: 'never' | 'ask', domain } or null. "Never" wins when both lists name it. */
export function ruleFor(host) {
  const h = cleanHost(host); if (!h) return null;
  const n = state.never.find(d => under(h, d)); if (n) return { kind: 'never', domain: n };
  const a = state.ask.find(d => under(h, d)); if (a) return { kind: 'ask', domain: a };
  return null;
}

// Who is reading: { agentId, chatId, jobId, owner }. Callers that cannot pass it in run their read inside withWho.
const als = new AsyncLocalStorage();
export const withWho = (who, fn) => (who ? als.run(who, fn) : fn());
export const currentWho = () => als.getStore() || null;
const scopeOf = (who) => String(who?.jobId || who?.chatId || who?.agentId || 'desk');
const key = (domain, who) => scopeOf(who) + '|' + domain;

/** The owner's answer for this domain in this job or chat turn: true, false, or undefined (not asked). */
export function decided(domain, who) {
  const d = state.decisions.get(key(domain, who));
  if (!d) return undefined;
  if (Date.now() - d.at > DECISION_MS) { state.decisions.delete(key(domain, who)); return undefined; }
  return d.ok;
}
/** Ask the owner once per job or turn (the Network module's asker goes through the approval door). No asker: no. */
export async function askFirst({ domain, url, who }) {
  const prev = decided(domain, who); if (prev !== undefined) return prev;
  const k = key(domain, who);
  if (state.pending.has(k)) return state.pending.get(k);
  const p = (async () => {
    let ok = false;
    try { ok = state.asker ? (await state.asker({ domain, url: String(url || '').slice(0, 500), who: who || null })) === true : false; } catch { ok = false; }
    state.decisions.set(k, { ok, at: Date.now() });
    return ok;
  })();
  state.pending.set(k, p);
  try { return await p; } finally { state.pending.delete(k); }
}

const err = (code, message) => Object.assign(new Error(message), { code });
const NEVER_LINE = (d) => `You set a rule: agents never open ${d} or any name under it.`;
const DENIED_LINE = (d) => `You said no to opening ${d}, so it was not opened.`;
const ASK_LINE = (d) => `You asked to be asked before agents open ${d}. It was not opened without your yes.`;

/**
 * Text-only rule check for one host. Throws { code: 'rule_never' | 'rule_denied' | 'rule_ask' } or returns the rule
 * (null when none). With { asking: true } an "ask first" rule is returned for the caller to ask about.
 */
export function siteRuleSync(host, { who = null, asking = false } = {}) {
  const w = who || currentWho();
  if (w?.owner === true) return null;             // the rules bind the agents, not the owner's own clicks
  const r = ruleFor(host); if (!r) return null;
  if (r.kind === 'never') throw err('rule_never', NEVER_LINE(r.domain));
  const d = decided(r.domain, w);
  if (d === false) throw err('rule_denied', DENIED_LINE(r.domain));
  if (d === true || asking) return r;
  throw err('rule_ask', ASK_LINE(r.domain));
}
/** The same, and for an "ask first" site it asks the owner (once per job or turn). Throws like siteRuleSync. */
export async function siteRuleAsk(host, url, { who = null } = {}) {
  const w = who || currentWho();
  const r = siteRuleSync(host, { who: w, asking: true });
  if (!r || r.kind !== 'ask') return r;
  if (!(await askFirst({ domain: r.domain, url, who: w }))) throw err('rule_denied', DENIED_LINE(r.domain));
  return r;
}

/** Chromium switch that makes "never" sites unreachable by name for a browser started now (redirects included). */
export function resolverRules() {
  const names = state.never.filter(d => !net.isIP(d));
  if (!names.length) return null;
  return '--host-resolver-rules=' + names.flatMap(d => [`MAP ${d} ~NOTFOUND`, `MAP *.${d} ~NOTFOUND`]).join(', ');
}

/** Which module called (from a stack): "research", "sales" ... Used to name the job behind an unnamed read. */
export function callerModule(stack, skip = ['search', 'network']) {
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = /[\\/]modules[\\/]([a-z0-9_-]+)[\\/]/i.exec(line);
    if (m && !skip.includes(m[1])) return m[1];
  }
  return null;
}
