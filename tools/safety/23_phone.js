// Probe: Approve from your phone. From another address on this PC (127.0.0.2, standing in for a phone on the Wi-Fi) it
// tries to reach the desk's other routes through the phone listener and on the desk's own port, to rebind the Host
// header, to guess the linking code (all at once and one by one), to reuse a removed phone's token, and to decide one
// approval twice. Also: a module that is not Models tries to change the owner's model keys. Each must change nothing.
// Control: a linked phone decides one approval once.
import { testDesk } from '../../test/helpers/desk.js';
import http from 'node:http'; import path from 'node:path'; import { fileURLToPath } from 'node:url';

const out = []; const line = (tag, bad, held, bypass) => out.push(bad ? `BYPASS(${tag}): ${bypass}` : `HELD(${tag}): ${held}`);
const PAGE = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const t = await testDesk({ modules: ['chat'], env: { APD_PHONE_HOST: '127.0.0.2', APD_PHONE_PORT: '0' } });
const tick = () => new Promise(r => setTimeout(r, 20));
try {
  // off by default
  const off = (await t.call('/api/phone')).json;
  line('phone-off', off.on || off.listening || t.desk.phone.listening, 'a fresh desk has the phone page off: nothing listens on another address', `on ${off.on}, listening ${off.listening}`);
  const base = (await t.call('/api/phone/switch', { body: { on: true } })).json.address;
  const at = (p, { token, body, method } = {}) => fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, text: await r.text() }));
  const code = async () => (await t.call('/api/phone/code', { method: 'POST', headers: PAGE })).json.code;

  // 1. the desk's other routes from another address
  await t.call('/api/m/chat/chats', { body: { title: 'secret-chat-for-phone-probe' } });
  const paths = ['/api/state', '/api/approvals', '/api/activity', '/api/settings', '/api/m/chat/chats', '/api/events', '/api/keys/services', '/router/v1/models', '/api/phone', '/', '/index.html', '/ui/shell.js', '/modules/chat/ui.js', '/api/panic'];
  const reached = [];
  for (const p of paths) for (const m of ['GET', 'POST']) {
    const r = await at(p, { method: m, body: m === 'POST' ? {} : undefined });
    if (p === '/' && m === 'GET') { if (/secret-chat|__APD_SESSION__|x-apd-session/.test(r.text)) reached.push('page carries desk data'); continue; }
    if (r.status === 200 || /secret-chat|"pendingApprovals"|"modules"/.test(r.text)) reached.push(`${m} ${p} -> ${r.status}`);
  }
  let deskPort = 'refused'; try { await fetch(`http://127.0.0.2:${t.core.port}/api/state`); deskPort = 'answered'; } catch {}
  line('phone-other-routes', reached.length > 0 || deskPort !== 'refused', `from another address the phone listener answered none of ${paths.length * 2} desk routes and the desk's own port did not answer at all`, `${reached.join('; ')} desk port ${deskPort}`);
  const u = new URL(base);
  const rebind = await new Promise((res) => http.get({ host: u.hostname, port: u.port, path: '/list', headers: { host: 'desk.attacker.example' } }, (r) => { r.resume(); res(r.statusCode); }).on('error', () => res(0)));
  line('phone-rebind', rebind !== 403, 'a foreign Host header on the phone listener got 403', `status ${rebind}`);

  // 2. guess the code: 60 guesses at once, then the right code
  t.desk.phone.limits.lockMs = 400;   // a short wait so the probe can go on (a real desk: five minutes)
  const real = await code();
  const guesses = Array.from({ length: 60 }, (_, i) => String((Number(real) + 1 + i) % 1000000).padStart(6, '0'));
  const answers = await Promise.all(guesses.map(c => at('/link', { body: { code: c, name: 'guess' } })));
  const linked = answers.filter(r => r.status === 200).length;
  const after = await at('/link', { body: { code: real, name: 'late' } });
  line('phone-code-guess', linked > 0 || after.status === 200, `60 guesses at once linked nothing; after five wrong tries linking locked and the live code was dropped (${after.status})`, `linked ${linked}, right code after ${after.status}`);

  // 3. a removed phone's token
  await new Promise(r => setTimeout(r, 450));
  const linkR = JSON.parse((await at('/link', { body: { code: await code(), name: 'Probe phone' } })).text);
  const dev = (await t.call('/api/phone')).json.devices.find(d => d.name === 'Probe phone');
  await t.call(`/api/phone/devices/${dev.id}/remove`, { body: {} });
  const reuse = await at('/list', { token: linkR.token });
  line('phone-removed-token', reuse.status !== 401, `a removed phone's token is refused (${reuse.status})`, `status ${reuse.status}`);

  // 4. decide twice (and control: a linked phone decides it once)
  const tok = JSON.parse((await at('/link', { body: { code: await code(), name: 'Second phone' } })).text).token;
  const asked = t.core.approval.request({ agentId: 'coordinator', action: 'send.person', title: 'Probe send', payload: { to: 'a@shop.example', body: 'x' } });
  let p; for (let i = 0; i < 100 && !p; i++) { p = t.core.approval.listPending()[0]; await tick(); }
  const [a, b] = await Promise.all([at('/decide/' + p.id, { token: tok, body: { decision: 'approve' } }), at('/decide/' + p.id, { token: tok, body: { decision: 'deny' } })]);
  const d = await asked;
  const lines = t.core.approval.activityList(50).filter(x => x.title === 'Probe send').length;
  const oks = [a, b].filter(r => r.status === 200).length;
  line('phone-decide-twice', oks !== 1 || lines !== 1, `two decisions sent at once: one was taken (${d.ok ? 'approved' : 'declined'}), the other answered "already decided", one line in the activity log`, `ok answers ${oks}, activity lines ${lines}`);
  const desk = await t.call(`/api/approvals/${p.id}/${d.ok ? 'deny' : 'approve'}`, { method: 'POST' });
  line('phone-then-desk', desk.json?.status !== (d.ok ? 'approved' : 'denied'), 'deciding again at the desk after the phone changed nothing', `status ${desk.json?.status}`);
} finally { await t.close(); }

// 5. a module that is not Models and the owner's model keys
const kd = await testDesk({ modulesDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'keygrab-modules') });
try {
  try { await kd.core.modules.set('keygrab', true); } catch {}
  const r = kd.core.modules.api('keygrab')?.tryKeys?.() || {};
  const planted = JSON.stringify(kd.core.model.listKeys()).includes('planted');
  line('model-keys-module', r.add || r.toggle || r.remove || r.tier || planted, 'a module that is not Models gets the key list only: no add, switch or remove, and nothing was planted', `add ${r.add}, toggle ${r.toggle}, remove ${r.remove}, planted ${planted} (core/modules.js must build ctx.model with forModule(id))`);
} finally { await kd.close(); }
for (const l of out) console.log(l);
