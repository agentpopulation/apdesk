// Probe: several people on one PC (contracts/PEOPLE.md). Person B, who is not the keeper, tries to install an update,
// switch a module off and take the desk Offline; one person's token tries to read the other's chats and keys and to
// listen to the other's events; PIN guesses are sent all at once to get past the wait; a rival floods wrong PINs to
// lock a person out; B tries to get the house pairing code, switch paid OpenRouter on (the PC's shared key), and read
// the keeper's backups outside the data folder through Files; the looks route is sent security, spend and other keys.
// Each must change nothing. Control: the keeper's own token does the gated things.
import { testDesk } from '../../test/helpers/desk.js';
import fs from 'node:fs'; import path from 'node:path';

const KEEPER_NO = 'Only the Admin of this PC can do that.';
const t = await testDesk({ modules: ['chat', 'network', 'files'] });
const as = (token) => (p, o = {}) => t.call(p, { ...o, session: false, headers: token ? { 'x-apd-session': token } : {} });
const out = [];
const line = (tag, bad, held, bypass) => out.push(bad ? `BYPASS(${tag}): ${bypass}` : `HELD(${tag}): ${held}`);
try {
  const k = as(t.desk.session);
  await k('/api/people/me/pin', { body: { pin: '2468' } });
  await k('/api/modules/network/on', { method: 'POST' });
  const id = (await k('/api/people', { body: { name: 'Person B', pin: '4821' } })).json.person.id;
  const tokB = (await as(null)('/api/people/enter', { body: { id, pin: '4821' } })).json.token;
  const b = as(tokB); const cB = t.desk.spaceOf(id).core;

  // 1. B installs an update, switches a module, goes Offline
  let installs = 0; const realInstall = t.core.updater.install.bind(t.core.updater);
  t.core.updater.install = async (...a) => { installs++; return realInstall(...a); };
  const upd = await b('/api/update/install', { method: 'POST' });
  line('people-update', upd.status !== 403 || installs > 0, `a non-keeper's install answered ${upd.status} "${upd.json?.error}" and the updater was never called`, `status ${upd.status}, installs ${installs}`);
  const mod = await b('/api/modules/network/off', { method: 'POST' });
  line('people-module', mod.status !== 403 || !t.core.modules.isOn('network') || !cB.modules.isOn('network'), `a non-keeper's module switch answered ${mod.status}; network stays on for both people`, `status ${mod.status}`);
  const off = await b('/api/settings', { body: { online: false, theme: 'dark' } });
  let direct = 'refused'; try { cB.settings.set('online', false); direct = 'written'; } catch {}
  line('people-online', off.status !== 403 || t.core.settings.get('online') !== true || direct !== 'refused', `a non-keeper's Offline answered ${off.status}; B's own settings cannot write it either; the desk stays Online`, `status ${off.status}, online ${t.core.settings.get('online')}, direct ${direct}`);

  // 2. one person's token reads the other's chats, keys and events
  await b('/api/m/chat/chats', { body: { title: 'secret-chat-of-B' } });
  await b('/api/keys/services/serper', { body: { value: 'secret-key-of-b-12345' } });
  await k('/api/m/chat/chats', { body: { title: 'secret-chat-of-A' } });
  const ac = new AbortController(); let heard = '';
  const es = await fetch(t.base + '/api/events?session=' + t.desk.session, { signal: ac.signal });
  const reading = (async () => { try { const rd = es.body.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; heard += Buffer.from(value).toString(); } } catch {} })();
  await new Promise(r => setTimeout(r, 50)); cB.events.emit('toast', { text: 'secret-event-of-B' }); await new Promise(r => setTimeout(r, 80));
  ac.abort(); await reading;
  const seenByA = JSON.stringify([(await k('/api/m/chat/chats')).json, (await k('/api/keys/services')).json, (await k('/api/state')).json, (await k('/api/activity')).json]) + heard;
  const seenByB = JSON.stringify([(await b('/api/m/chat/chats')).json, (await b('/api/state')).json]);
  const noTok = [(await as(null)('/api/m/chat/chats')).status, (await as('ab'.repeat(24))('/api/keys/services')).status];
  const leaked = /secret-(chat|key|event)-of-b/.test(seenByA) || seenByB.includes('secret-chat-of-A') || noTok.some(s => s !== 401);
  line('people-read', leaked, `A's token saw none of B's chats, keys or events; B's saw none of A's; no token or a made-up one answered ${noTok.join(', ')}`, `seen by A: ${/secret-[a-z]+-of-b/i.exec(seenByA)?.[0]}, no token: ${noTok}`);

  // 3. PIN guesses sent all at once: a wrong PIN never gets a token; the right one always enters (no lockout)
  const guesses = Array.from({ length: 40 }, (_, i) => (i === 20 ? '4821' : String(5000 + i)));
  const answers = await Promise.all(guesses.map(pin => as(null)('/api/people/enter', { body: { id, pin } })));
  const wrongTokens = answers.filter((r, i) => guesses[i] !== '4821' && r.json?.token).length;
  const later = await as(null)('/api/people/enter', { body: { id, pin: '4821' } });
  line('people-pin-guess', wrongTokens > 0 || !later.json?.token, `40 guesses at once: no wrong PIN got a token; the right PIN still enters (${later.status})`, `wrongTokens ${wrongTokens}, later ${later.status}`);

  // 3b. a rival floods wrong PINs for the keeper (enter needs no token): the keeper is never locked out of their own desk
  const kid = t.desk.people.keeper().id;
  for (let i = 0; i < 8; i++) await as(null)('/api/people/enter', { body: { id: kid, pin: String(9000 + i) } });
  const keeperIn = await as(null)('/api/people/enter', { body: { id: kid, pin: '2468' } });
  line('people-lockout', !keeperIn.json?.token, `after a rival floods wrong PINs for the keeper, the keeper's own PIN still enters (${keeperIn.status})`, `keeper entry ${keeperIn.status}`);

  // 3c. the house pairing code admits new browsers to the whole PC: a non-keeper is refused
  const pc = await b('/api/security/pair-code', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
  line('people-paircode', pc.status !== 403 || pc.json?.error !== KEEPER_NO || !!pc.json?.address, `a non-keeper cannot get the pairing code (${pc.status} "${pc.json?.error}")`, `status ${pc.status}, address ${pc.json?.address}`);

  // 3d. paid OpenRouter spends the PC's shared key: a non-keeper cannot switch it on, by either route
  const paid1 = await b('/api/settings/paid-models', { body: { provider: 'openrouter', on: true } });
  const paid2 = await b('/api/settings/spend', { body: { openrouterPaid: true } });
  const bPaid = cB.settings.get('openrouter.allowPaid') === true;
  line('people-paid', paid1.status !== 403 || paid1.json?.error !== KEEPER_NO || bPaid, `a non-keeper cannot switch paid OpenRouter on (${paid1.status}); B's space stays free-only`, `paid-models ${paid1.status}, spend ${paid2.status}, allowPaid ${bPaid}`);

  // 3e. the keeper's backups live outside the data folder: B cannot read them through Files, even in B's own space
  const kbDir = t.core.storage.backupsDir; fs.mkdirSync(kbDir, { recursive: true });
  const secret = 'KEEPER-BACKUP-SECRET-BYTES'; fs.writeFileSync(path.join(kbDir, 'apdesk-backup-keeper.zip'), secret);
  const gr = await b('/api/m/files/grants', { body: { root: 'drive:root' } });
  let gid = gr.json?.approvalId || cB.approval.listPending().find(a => a.action === 'file.read.outside')?.id;
  if (gid) await b('/api/approvals/' + gid + '/approve', { method: 'POST' });
  const rel = path.join(kbDir, 'apdesk-backup-keeper.zip').replace(/^\/+/, '');
  const read = await b('/api/m/files/raw?root=drive:root&path=' + encodeURIComponent(rel));
  const leak = (read.text || '').includes(secret);
  line('people-backups', leak || read.status === 200, `B's Files cannot read the keeper's backups outside the data folder (${read.status})`, `status ${read.status}, leak ${leak}`);

  // 4. the looks route with security, spend and other keys
  const level = cB.approval.level; const before = JSON.stringify(cB.settings.all());
  const looks = [];
  for (const body of [{ 'security.level': 'open' }, { theme: 'dark', 'security.autoApproveUntil': '2099-01-01' }, { 'spend.perDay': 99999999 }, { name: 'x', online: false }, { colour: '#000000', keeper: true }, JSON.parse('{"__proto__":{"keeper":true}}'), { theme: 'dark', 'openrouter.allowPaid': true }]) looks.push((await b('/api/people/me/look', { body })).status);
  const changed = cB.approval.level !== level || JSON.stringify(cB.settings.all()) !== before || t.desk.people.get(id).keeper;
  line('people-looks', changed || looks.some(s => s !== 400), `${looks.length} bodies with a key other than name, emoji, colour and theme were refused (${[...new Set(looks)].join(', ')}); nothing changed`, `statuses ${looks}, changed ${changed}`);

  // 5. Incognito (contracts/PEOPLE.md): nothing it writes survives leaving; it reads none of the person's real data;
  // spend still counts toward the person's own day total, so Incognito cannot get around the limits.
  await b('/api/m/chat/chats', { body: { title: 'real-chat-of-B-for-incognito' } });
  const spentBefore = cB.approval.spent('day');
  const incEnter = await b('/api/people/incognito', { method: 'POST' });
  const incTok = incEnter.json.token; const incSpace = t.desk.spaceForToken(incTok);
  const incScratch = incSpace?.core.incognito?.scratch;
  const inc = as(incTok);
  const incSawReal = (await inc('/api/m/chat/chats')).json.chats.some(c => c.title === 'real-chat-of-B-for-incognito');
  await inc('/api/m/chat/chats', { body: { title: 'incognito-canary-of-B' } });
  incSpace.core.storage.run("INSERT INTO calls (at, cost_minor, currency, provider, model, ok) VALUES (?, 250, ?, 'paid', 'm', 1)", new Date().toISOString(), cB.settings.get('currency'));
  await inc('/api/people/leave', { method: 'POST' });
  const scratchGone = !!incScratch && !fs.existsSync(incScratch);
  const tokB2 = (await as(null)('/api/people/enter', { body: { id, pin: '4821' } })).json.token;
  const realChats = (await as(tokB2)('/api/m/chat/chats')).json.chats.map(c => c.title);
  const incTrace = realChats.includes('incognito-canary-of-B') || incSawReal || !scratchGone;
  line('incognito-trace', incTrace, `Incognito wrote nothing durable (its chat is gone, its scratch folder wiped) and read none of B's real chats`, `canary survived ${realChats.includes('incognito-canary-of-B')}, read real ${incSawReal}, scratch gone ${scratchGone}`);
  const spentAfter = cB.approval.spent('day');
  line('incognito-spend', spentAfter < spentBefore + 250, `Incognito spend (250) counted toward B's own day total, so the limits still hold`, `day total ${spentBefore} -> ${spentAfter}`);

  // control: the keeper's own token
  const ctl = await k('/api/modules/network/off', { method: 'POST' });
  const ctlOff = await k('/api/settings', { body: { online: false } });
  line('people-control', !(ctl.status === 200 && !cB.modules.isOn('network') && ctlOff.status === 200 && cB.settings.get('online') === false), 'the keeper switched network off for both people and took the desk Offline', `status ${ctl.status} ${ctlOff.status}`);
} finally { await t.close(); }
for (const l of out) console.log(l);
