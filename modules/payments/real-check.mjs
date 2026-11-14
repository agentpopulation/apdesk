// Real checks for Payments and Spend: switch on, a real model asks to spend, the owner decides, it is logged; over the limit
// asks even inside an auto-approve window; switch off cleanly.  Run:  node modules/payments/real-check.mjs
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import { testDesk } from '../../test/helpers/desk.js';

const results = [];
const check = (name, ok, evidence = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(evidence).replace(/\s+/g, ' ').slice(0, 400)}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t = await testDesk({ real: true, modules: ['payments'] });
const waitPending = async (ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const p = (await t.call('/api/approvals')).json.pending.filter(a => a.action === 'spend'); if (p.length) return p.at(-1); await sleep(200); } return null; };
try {
  check('ships off', !t.core.modules.isOn('payments') && !t.core.modules.tools.has('spend_request'), '');
  const on = await t.call('/api/modules/payments/on', { body: {} });
  check('switches on: tool and routes appear', on.status === 200 && t.core.modules.tools.has('spend_request') && (await t.call('/api/m/payments/limits')).status === 200, `status ${on.status}`);
  const lim = await t.call('/api/settings/spend', { body: { perItem: 100000, perDay: 300000, perMonth: 1000000 } });
  const noOwner = await t.call('/api/settings/spend', { body: { perItem: 99999999 }, session: false });
  check('limits change only for the owner', lim.status === 200 && lim.json.limits.perItem === 100000 && noOwner.status === 403, `per item ${lim.json.limits.perItem} minor units; without the session ${noOwner.status}`);
  await t.call('/api/settings/security', { body: { level: 'careful' } });

  // a real model decides to call spend_request
  const tool = t.core.modules.tools.get('spend_request');
  const r = await t.core.model.chat({ agentId: 'operator', purpose: 'chat', tools: [{ name: tool.name, description: tool.description, parameters: tool.parameters }],
    messages: [{ role: 'system', content: 'You are Operator, an agent on the owner\'s desk. Before any purchase you must call spend_request.' }, { role: 'user', content: 'Please buy one 2 metre HDMI cable from a local shop. It costs ₹ 450. We need it for the meeting room TV.' }] });
  const callArgs = r.toolCalls.find(c => c.name === 'spend_request')?.args;
  check('a real model asks to spend through the tool', !!callArgs && Number(callArgs.price) === 450, `[${r.label}] ${JSON.stringify(callArgs)}`);
  const run = t.core.modules.runTool('spend_request', callArgs || { what: 'HDMI cable', price: 450 }, { agentId: 'operator', chatId: null });
  const pend = await waitPending();
  check('the spend goes to the owner (Careful, within limits)', pend && pend.amount === 45000 && /HDMI/i.test(pend.title), pend ? `${pend.title}, ${pend.amount} minor units ${pend.currency}` : 'nothing pending');
  await t.call(`/api/approvals/${pend.id}/approve`, { method: 'POST' });
  const out = await run;
  await sleep(300);
  const log1 = (await t.call('/api/m/payments/log')).json;
  const sec1 = (await t.call('/api/security')).json;
  check('approved, recorded in the spend log and counted in today\'s total', out.decision === 'approved' && log1.items[0]?.decision === 'approved' && log1.items[0]?.how === 'owner' && sec1.spentToday >= 45000, `tool says: ${out.note} | log: ${log1.items[0]?.what}, ${log1.items[0]?.amount}, ${log1.items[0]?.decision} | spent today ${sec1.spentToday}`);

  // over the limit inside an auto-approve window: still asks
  await t.call('/api/settings/auto-approve', { body: { window: 60 } });
  const small = await t.core.modules.runTool('spend_request', { what: 'USB-C adapter', price: 300 }, { agentId: 'operator' });
  const big = t.core.modules.runTool('spend_request', { what: 'Office monitor', price: 18000 }, { agentId: 'operator' });
  const p2 = await waitPending();
  check('inside the auto-approve window a small spend is auto-allowed', small.decision === 'approved', `${small.decision}`);
  check('over the limit it asks even inside the auto-approve window', p2 && /monitor/i.test(p2.title), p2 ? `${p2.title} is waiting; ${p2.detail || ''}` : 'not asked');
  await t.call(`/api/approvals/${p2.id}/deny`, { method: 'POST' });
  const bo = await big;
  const log2 = (await t.call('/api/m/payments/log')).json.items;
  check('the refusal is logged', bo.decision === 'denied' && log2[0].decision === 'denied', log2.slice(0, 3).map(x => `${x.what} ${x.amount} ${x.decision}/${x.how}`).join('; '));
  const noLog = await t.call('/api/m/payments/log', { session: false });
  check('the spend log is for the owner only', noLog.status === 403, `${noLog.status}`);

  // switch off cleanly
  const off = await t.call('/api/modules/payments/off', { body: {} });
  const gone = !t.core.modules.tools.has('spend_request') && (await t.call('/api/m/payments/limits')).status === 404;
  await t.call('/api/settings/auto-approve', { body: { window: 0 } }); await t.call('/api/settings/security', { body: { level: 'open' } });
  const asked = t.core.approval.request({ agentId: 'operator', action: 'spend', title: 'Small spend while off', amount: 100 });
  const p3 = await waitPending();
  check('switches off: tool and routes go; while off any spend asks even at Open', off.status === 200 && gone && p3 && /payments module is off|Small spend/.test(p3.title), `off ${off.status}; tool gone ${gone}; pending: ${p3?.title}`);
  t.core.approval.decide(p3.id, 'deny'); await asked;
} catch (e) { check('real check ran to the end', false, e.stack); }
finally { await t.close().catch(() => {}); }
process.exit(results.every(Boolean) ? 0 : 1);
