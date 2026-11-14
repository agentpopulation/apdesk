// Vault and Logins (module 22). Values never appear in a route answer except the owner's Reveal, never in an event, a log
// or a model message. With a master passphrase, login values are sealed with AES-256-GCM; while locked no module can read them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newKdf, deriveKey, seal, open, isSealed, wipe } from './crypto.js';

const CHECK = 'apd-vault-check';
const maskUser = (u) => { const s = String(u || ''); if (!s) return ''; const [name, dom] = s.split('@'); const m = name.length <= 2 ? name[0] + '•' : name.slice(0, 2) + '•'.repeat(Math.min(6, name.length - 2)); return dom ? `${m}@${dom}` : m; };
const siteOf = (s) => { const t = String(s || '').trim(); try { return new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t).hostname.toLowerCase(); } catch { return t.toLowerCase().slice(0, 200); } };

export async function activate(ctx) {
  let key = null;                                   // the unlocked key, in memory only
  const providerNames = (() => { try { const p = JSON.parse(fs.readFileSync(path.join(ctx.root, 'app', 'core', 'providers.json'), 'utf8')).providers; return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.name])); } catch { return {}; } })();
  const master = () => ctx.kv.get('master', null);
  const locked = () => !!master() && !key;
  const index = () => ctx.kv.get('logins', []);
  const saveIndex = (list) => ctx.kv.set('logins', list);
  const aad = (id) => 'apd-vault/login/v1|' + id;
  const err = (msg, status) => Object.assign(new Error(msg), { status });
  const activity = (title) => ctx.db.run('INSERT INTO activity (at, agent_id, action, title, how) VALUES (?, ?, ?, ?, ?)', new Date().toISOString(), null, 'vault', title, 'owner');

  function readLogin(id) {
    if (locked()) throw err('The vault is locked. Unlock it with your passphrase first.', 423);
    const raw = ctx.secrets.get('login:' + id);
    if (raw == null) throw err('This login has no saved password on this desk (it may have come from a backup without keys).', 404);
    return JSON.parse(isSealed(raw) ? open(key, aad(id), raw) : raw);
  }
  function writeLogin(id, value) {
    const plain = JSON.stringify(value);
    ctx.secrets.set('login:' + id, master() ? seal(key, aad(id), plain) : plain);
  }
  async function keyFrom(passphrase) {
    const m = master(); if (!m) return null;
    const k = await deriveKey(passphrase, m.kdf);
    try { if (open(k, 'apd-vault/check', m.check) === CHECK) return k; } catch {}
    wipe(k); return null;
  }
  const view = () => ({
    locked: locked(), hasMaster: !!master(),
    logins: index().map(l => ({ ...l, hasValue: ctx.secrets.has('login:' + l.id) })),
  });

  // ---- provider keys, through the model door (values come back masked)
  ctx.route('GET', '/overview', (req, res) => {
    const keys = ctx.model.keys.list();
    const providers = Object.entries(keys).map(([id, list]) => ({ id, name: providerNames[id] || id, keys: list.map(k => ({ id: k.id, label: k.label, value: k.value, enabled: k.enabled, created: k.created, fromEnvironment: !k.created || /environment/i.test(k.label || '') })) }));
    const credentials = ctx.db.all("SELECT kind, label, created FROM secrets WHERE kind LIKE 'module:%' AND kind != 'module:vault' ORDER BY kind, label").map(r => ({ module: r.kind.slice(7), name: r.label, created: r.created }));
    const mods = ctx.modules.list();
    ctx.json(res, { providers, credentials: credentials.map(c => ({ ...c, moduleName: mods.find(m => m.id === c.module)?.name || c.module })), ...view() });
  });
  const owner = (res, o, what) => { if (o) return false; ctx.json(res, { error: `Only the owner at this desk can ${what}.` }, 403); return true; };
  ctx.route('POST', '/keys', (req, res, { body, owner: o }) => {
    if (owner(res, o, 'add a key')) return;
    try { ctx.json(res, ctx.model.keys.add(String(body?.provider || ''), String(body?.value || ''), String(body?.label || ''))); } catch (e) { ctx.json(res, { error: e.message }, 400); }
  });
  ctx.route('POST', '/keys/:id', (req, res, { params, body, owner: o }) => { if (owner(res, o, 'switch a key')) return; ctx.model.keys.toggle(params.id, !!body?.enabled); ctx.json(res, { ok: true }); });
  ctx.route('DELETE', '/keys/:id', (req, res, { params, owner: o }) => { if (owner(res, o, 'remove a key')) return; ctx.model.keys.remove(params.id); ctx.json(res, { ok: true }); });

  // ---- logins for agents' computers
  ctx.route('GET', '/logins', (req, res) => ctx.json(res, view()));
  ctx.route('POST', '/logins', (req, res, { body, owner: o }) => {
    if (owner(res, o, 'save a login')) return;
    if (locked()) return ctx.json(res, { error: 'The vault is locked. Unlock it first.' }, 423);
    const site = siteOf(body?.site), username = String(body?.username || '').trim(), password = String(body?.password || '');
    if (!site || !username || !password) return ctx.json(res, { error: 'A login needs a site, a username and a password.' }, 400);
    const list = index(); const t = new Date().toISOString();
    let row = list.find(l => l.site === site && l.userKey === crypto.createHash('sha256').update(username).digest('hex').slice(0, 12));
    if (!row) { row = { id: 'lg_' + crypto.randomBytes(5).toString('hex'), site, user: maskUser(username), userKey: crypto.createHash('sha256').update(username).digest('hex').slice(0, 12), created: t }; list.push(row); }
    row.updated = t;
    writeLogin(row.id, { username, password });
    saveIndex(list);
    activity(`Saved a login for ${site}`);
    ctx.json(res, { ok: true, id: row.id, ...view() });
  });
  ctx.route('POST', '/logins/:id/reveal', (req, res, { params, owner: o }) => {
    if (owner(res, o, 'see a password')) return;
    if (!index().some(l => l.id === params.id)) return ctx.json(res, { error: 'No such login.' }, 404);
    const v = readLogin(params.id);
    activity(`Showed the login for ${index().find(l => l.id === params.id)?.site}`);
    ctx.json(res, { username: v.username, password: v.password });
  });
  ctx.route('DELETE', '/logins/:id', (req, res, { params, owner: o }) => {
    if (owner(res, o, 'remove a login')) return;
    const l = index().find(x => x.id === params.id); if (!l) return ctx.json(res, { error: 'No such login.' }, 404);
    ctx.secrets.set('login:' + l.id, null); saveIndex(index().filter(x => x.id !== l.id));
    activity(`Removed the login for ${l.site}`);
    ctx.json(res, { ok: true, ...view() });
  });

  // ---- master passphrase
  ctx.route('POST', '/master', async (req, res, { body, owner: o }) => {
    if (owner(res, o, 'set the passphrase')) return;
    const next = String(body?.passphrase || '');
    if (next.length < 8) return ctx.json(res, { error: 'Use a passphrase of at least 8 characters.' }, 400);
    let old = null;
    if (master()) { old = await keyFrom(String(body?.current || '')); if (!old) return ctx.json(res, { error: 'The current passphrase is wrong.' }, 403); }
    const values = index().filter(l => ctx.secrets.has('login:' + l.id)).map(l => { const raw = ctx.secrets.get('login:' + l.id); return [l.id, isSealed(raw) ? open(old, aad(l.id), raw) : raw]; });
    const kdf = newKdf(); const k = await deriveKey(next, kdf);
    ctx.kv.set('master', { kdf, check: seal(k, 'apd-vault/check', CHECK), set: new Date().toISOString() });
    for (const [id, plain] of values) ctx.secrets.set('login:' + id, seal(k, aad(id), plain));
    wipe(old); if (key && key !== k) wipe(key); key = k;
    activity(old ? 'Changed the vault passphrase' : 'Locked logins behind a passphrase');
    ctx.json(res, { ok: true, ...view() });
  });
  ctx.route('POST', '/master/remove', async (req, res, { body, owner: o }) => {
    if (owner(res, o, 'remove the passphrase')) return;
    if (!master()) return ctx.json(res, { ok: true, ...view() });
    const k = await keyFrom(String(body?.passphrase || '')); if (!k) return ctx.json(res, { error: 'The passphrase is wrong.' }, 403);
    for (const l of index()) { const raw = ctx.secrets.get('login:' + l.id); if (raw && isSealed(raw)) ctx.secrets.set('login:' + l.id, open(k, aad(l.id), raw)); }
    ctx.kv.del('master'); wipe(k); wipe(key); key = null;
    activity('Removed the vault passphrase');
    ctx.json(res, { ok: true, ...view() });
  });
  ctx.route('POST', '/unlock', async (req, res, { body, owner: o }) => {
    if (owner(res, o, 'unlock the vault')) return;
    const k = await keyFrom(String(body?.passphrase || ''));
    if (!k) { await new Promise(r => setTimeout(r, 600)); return ctx.json(res, { error: 'The passphrase is wrong.' }, 403); }
    if (key) wipe(key); key = k; ctx.json(res, { ok: true, ...view() });
  });
  ctx.route('POST', '/lock', (req, res) => { if (key) wipe(key); key = null; ctx.json(res, { ok: true, ...view() }); });

  ctx.expose({
    /** Sites and masked usernames only; never values. */
    list: () => ({ locked: locked(), logins: index().map(({ id, site, user }) => ({ id, site, user, hasValue: ctx.secrets.has('login:' + id) })) }),
    /**
     * For the browser module to fill a sign-in form. Ask first with
     *   ctx.approval.request({ action: 'login', title, payload: { site, loginId } })
     * and pass the granted id. The value must never go to a model, an event or a log.
     */
    loginFor(id, approvalId) {
      if (locked()) throw err('The vault is locked. Unlock it with your passphrase first.', 423);
      const l = index().find(x => x.id === id); if (!l) throw err('No such login.', 404);
      ctx.approval.assertGranted(approvalId, 'login', { site: l.site, loginId: l.id });
      return readLogin(id);
    },
  });
  return { async deactivate() { if (key) wipe(key); key = null; } };
}
