// Real check for Social: switch on, a REAL model drafts a post and rewrites it for two networks, the owner approves
// (stops at "approved, not posted: no account connected"), a post attempt without approval is refused, switch off.
// Run:  node modules/social/real-check.mjs
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import { testDesk } from '../../test/helpers/desk.js';
const results = []; const check = (name, ok, ev = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(ev).replace(/\s+/g, ' ').slice(0, 300)}`); };
const wait = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 300)); } return null; };
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const t = await testDesk({ real: true, modules: ['social'] });
const realFetch = globalThis.fetch; const outside = [];
try {
  let r = await t.call('/api/m/social/drafts');
  check('off at first: routes answer 404', r.status === 404, `status ${r.status}`);
  r = await t.call('/api/modules/social/on', { method: 'POST' });
  const ui = await fetch(t.base + '/modules/social/ui.js');
  check('switches on: menu place "Social" and its screen', r.json?.on && r.json.menu?.[0]?.label === 'Social' && ui.status === 200, `menu ${r.json?.menu?.map(m => m.label)} ui.js ${ui.status}`);

  // the model door is the only network use from here on; count any other outside call the module might make
  globalThis.fetch = (u, i) => { const h = new URL(String(u)).hostname; if (!['127.0.0.1', 'localhost'].includes(h) && !/googleapis|openrouter|ovh|pollinations|router/.test(h)) outside.push(h); return realFetch(u, i); };

  r = await t.call('/api/m/social/drafts/write', { body: { network: 'linkedin', brief: 'Our small team moved our server racks from one big data centre to three small edge sites in Pune, Jaipur and Kochi. Pages load faster for users in those cities. Power cuts were the hardest part. Write it as a short lesson-learned post.' } });
  const li = r.json;
  check('a real model drafts a LinkedIn post (label shown)', r.status === 200 && li?.text?.length > 80 && li.chars <= 3000 && li.label, `[${li?.label}] ${li?.chars} chars: ${li?.text?.slice(0, 120)}`);
  await pause(3000);
  r = await t.call(`/api/m/social/drafts/${li.id}/rewrite`, { body: { network: 'x' } });
  const x = r.json;
  check('rewritten for X within 280 characters', r.status === 200 && x?.network === 'x' && x.chars <= 280 && x.chars > 20 && x.label, `[${x?.label}] ${x?.chars} chars${x?.cut ? ' (cut to fit)' : ''}: ${x?.text}`);
  await pause(3000);
  r = await t.call(`/api/m/social/drafts/${li.id}/rewrite`, { body: { network: 'reddit' } });
  const rd = r.json;
  check('rewritten for Reddit (title first line, no hashtags)', r.status === 200 && rd?.network === 'reddit' && rd.text.split('\n')[0].length <= 300 && !/#\w/.test(rd.text) && rd.label, `[${rd?.label}] title: ${rd?.text?.split('\n')[0]}`);

  // a post attempt without approval is refused, even with an account connected (dummy keys; no call is made)
  await t.call('/api/m/social/connect/x', { body: { consumerKey: 'dummy-ck', consumerSecret: 'dummy-cs', accessToken: 'dummy-at', accessSecret: 'dummy-as' } });
  const before = outside.length;
  r = await t.call(`/api/m/social/drafts/${x.id}/post`, { body: {} });
  const r2 = await t.call(`/api/m/social/drafts/${x.id}/post`, { body: { approvalId: 'ap_madeup' } });
  check('post without approval is refused before any network call', r.status === 403 && r2.status === 403 && outside.length === before, `${r.status} "${r.json?.error}" / made-up id ${r2.status}; outside calls ${outside.length - before}`);
  const keysOut = JSON.stringify((await t.call('/api/m/social/networks')).json);
  check('keys stay in secrets and never come back', !keysOut.includes('dummy-cs') && keysOut.includes('"connected":true'), '');
  await t.call('/api/m/social/connect/x', { body: { disconnect: true } });

  // approve as the owner: the door asks send.person; with no account it stops at "approved, not posted"
  r = await t.call(`/api/m/social/drafts/${li.id}/approve`, { method: 'POST' });
  const ap = (await t.call('/api/approvals')).json.pending.find(a => a.id === r.json.approvalId);
  check('"Approve and post" asks the door for send.person for that one post', ap?.action === 'send.person' && ap.title === 'Post to LinkedIn' && r.json.status === 'waiting', `"${ap?.title}" ${ap?.action} ${ap?.status}`);
  const notOwner = await t.call(`/api/approvals/${ap.id}/approve`, { method: 'POST', session: false });
  await t.call(`/api/approvals/${ap.id}/approve`, { method: 'POST' });
  const done = await wait(async () => { const d = (await t.call('/api/m/social/drafts')).json.items.find(z => z.id === li.id); return d?.status === 'approved' ? d : null; });
  check('owner approves: "approved, not posted: no account connected", with Copy and Open offered', notOwner.status === 403 && done && /not posted: no account connected/.test(done.note) && /^https:\/\/www\.linkedin\.com\//.test(done.openUrl), `${done?.status}: ${done?.note} open ${done?.openUrl}`);

  // a post approved, then edited, is refused even with an account connected (dummy keys; refused before any call)
  r = await t.call(`/api/m/social/drafts/${x.id}/approve`, { method: 'POST' });
  const xApproval = r.json.approvalId;
  await t.call(`/api/approvals/${xApproval}/approve`, { method: 'POST' });
  await wait(async () => (await t.call('/api/m/social/drafts')).json.items.find(z => z.id === x.id)?.status === 'approved');
  await t.call(`/api/m/social/drafts/${x.id}/edit`, { body: { text: 'Buy our product now, limited offer!' } });
  await t.call('/api/m/social/connect/x', { body: { consumerKey: 'dummy-ck', consumerSecret: 'dummy-cs', accessToken: 'dummy-at', accessSecret: 'dummy-as' } });
  const before2 = outside.length;
  r = await t.call(`/api/m/social/drafts/${x.id}/post`, { body: { approvalId: xApproval } });
  check('a post edited after approval is refused before any network call', r.status === 403 && outside.length === before2, `${r.status} "${r.json?.error}"; outside calls ${outside.length - before2}`);
  await t.call('/api/m/social/connect/x', { body: { disconnect: true } });

  // the Coordinator tool
  const tool = await t.desk.modules.runTool('social_draft', { network: 'instagram', text: 'Three cities, three edge sites, one lesson: plan for power first. #edge #infra' }, { agentId: 'coordinator' });
  check('tool social_draft makes a waiting draft and posts nothing', tool.ok && /Nothing has been posted/.test(tool.status), tool.status);

  await t.call('/api/modules/social/off', { method: 'POST' });
  r = await t.call('/api/m/social/drafts');
  const mods = (await t.call('/api/modules')).json.modules.find(m => m.id === 'social');
  const uiOff = await fetch(t.base + '/modules/social/ui.js');
  check('switches off: routes 404, screen gone, tool gone', r.status === 404 && !mods.on && uiOff.status === 404 && !(await t.call('/api/state')).json.tools.some(x => x.name === 'social_draft'), `route ${r.status} ui.js ${uiOff.status} on=${mods.on}`);
} catch (e) { check('no crash', false, e.stack); }
finally { globalThis.fetch = realFetch; await t.close(); }
console.log('Posting to Reddit or X with a real account: not checked (no account in this session).');
process.exit(results.every(Boolean) ? 0 : 1);
