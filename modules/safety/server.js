// Safety (module 14): the Security section with Fine-tune and "Check the doors", and the untrusted-text guard.
import { scanUntrusted, wrapUntrusted } from './guard.js';
import { POLICY, LEVELS, ACTION_WORDS, RULE_WORDS, NOTES } from './policy.js';

export async function activate(ctx) {
  ctx.route('GET', '/policy', (req, res) => ctx.json(res, { levels: LEVELS, policy: POLICY, actions: ACTION_WORDS, rules: RULE_WORDS, notes: NOTES, level: ctx.settings.get('security.level'), paidOpenRouter: !!ctx.settings.get('openrouter.allowPaid') }));
  ctx.route('POST', '/scan', (req, res, { body }) => { const r = scanUntrusted(String(body?.text || '').slice(0, 200000)); ctx.json(res, { flags: r.flags, text: r.text }); });
  // "Check the doors": send-to-a-person asks at the current level. Creates one request nobody receives and cancels it.
  ctx.route('POST', '/probe-send', async (req, res, { owner }) => {
    if (!owner) return ctx.json(res, { error: 'Only the owner at this desk can run the check.' }, 403);
    const ac = new AbortController();
    const p = ctx.approval.request({ agentId: null, action: 'send.person', title: 'Safety check: a test message nobody receives', detail: 'Cancelled by itself in a moment', payload: { to: 'nobody (safety check)' }, signal: ac.signal });
    let pending = null;
    for (let i = 0; i < 20 && !pending; i++) { await new Promise(r => setTimeout(r, 25)); pending = ctx.approval.listPending().find(a => a.title.startsWith('Safety check:')); }
    const early = await Promise.race([p, new Promise(r => setTimeout(() => r(null), 0))]);
    ac.abort('check done');
    const d = await p;
    ctx.json(res, { level: ctx.settings.get('security.level'), asked: !!pending && !early, decidedWithoutYou: early ? early.how : null, cancelled: d.ok === false && d.reason === 'aborted' });
  });
  // Stopped by Panic: approvals that were waiting when Panic was pressed. Read here; only the owner dismisses them.
  ctx.route('GET', '/stopped', (req, res) => ctx.json(res, { items: ctx.approval.listStopped() }));
  ctx.route('POST', '/stopped/dismiss', (req, res, { body, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Only the owner at this desk can dismiss these.' }, 403);
    if (!body?.all && !body?.id) return ctx.json(res, { error: 'Say which item, or all.' }, 400);
    ctx.json(res, { dismissed: ctx.approval.dismissStopped(body.all ? 'all' : String(body.id)) });
  });
  ctx.expose({ scanUntrusted, wrapUntrusted });
  return { async deactivate() {} };
}
