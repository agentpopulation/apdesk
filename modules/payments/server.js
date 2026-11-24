// Module 24: Payments and Spend. Limits live in the approval door (Settings › Payments and spend); this module keeps the
// spend log and gives agents spend_request, which only asks the owner through the door. Nothing is ever paid by the app.
export async function activate(ctx) {
  ctx.db.migrate(1, `CREATE TABLE IF NOT EXISTS m_payments_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, approval_id TEXT, agent_id TEXT, chat_id TEXT,
    what TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT, url TEXT, why TEXT, decision TEXT NOT NULL, how TEXT, decided TEXT)`);
  const now = () => new Date().toISOString();
  const limits = () => { const s = ctx.approval.state(); return { ...s.limits, spentToday: s.spentToday, spentMonth: s.spentMonth }; };

  /** Write one spend into the log (other modules call this too). amount is in minor units. */
  function record({ approvalId = null, agentId = null, chatId = null, what, amount, currency, url = null, why = null, decision = 'recorded', how = null }) {
    const r = ctx.db.run('INSERT INTO m_payments_log (at, approval_id, agent_id, chat_id, what, amount, currency, url, why, decision, how, decided) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      now(), approvalId, agentId, chatId, String(what || 'Spend').slice(0, 300), Math.round(Number(amount) || 0), currency || ctx.settings.get('currency'), url, why, decision, how, decision === 'waiting' ? null : now());
    ctx.events.emit('payments', { changed: true });
    return Number(r?.lastInsertRowid ?? 0);
  }
  const update = (id, patch) => { ctx.db.run('UPDATE m_payments_log SET approval_id = COALESCE(?, approval_id), decision = ?, how = ?, decided = ? WHERE id = ?', patch.approvalId ?? null, patch.decision, patch.how ?? null, now(), id); ctx.events.emit('payments', { changed: true }); };
  const list = (n = 100) => ctx.db.all('SELECT * FROM m_payments_log ORDER BY id DESC LIMIT ?', n).map(r => ({ id: r.id, at: r.at, approvalId: r.approval_id, agentId: r.agent_id, what: r.what, amount: r.amount, currency: r.currency, url: r.url, why: r.why, decision: r.decision, how: r.how, decided: r.decided }));

  /** Ask the owner (through the door) to allow a spend. Resolves when decided; `waitMs` returns early with "waiting". */
  async function request({ agentId = null, chatId = null, jobId = null, what, amount, currency, url = null, why = null, waitMs = 1500 }) {
    const minor = Math.round(Number(amount) || 0);
    if (!what || !(minor > 0)) throw new Error('Say what to buy and how much it costs.');
    const cur = currency || ctx.settings.get('currency');
    const id = record({ agentId, chatId, what, amount: minor, currency: cur, url, why, decision: 'waiting' });
    const over = overLimit(minor);
    const p = ctx.approval.request({ agentId, chatId, jobId: jobId || undefined, action: 'spend', title: `Buy: ${String(what).slice(0, 120)}`, detail: why ? String(why).slice(0, 200) : (over ? `Over your ${over}` : null), amount: minor, currency: cur, payload: { what, url, amount: minor, currency: cur }, signal: ctx.panic.signal })
      .then((d) => { update(id, { approvalId: d.id, decision: d.ok ? 'approved' : (d.reason || 'denied'), how: d.how || d.reason }); return d; });
    const d = await Promise.race([p, new Promise(r => setTimeout(() => r(null), waitMs))]);
    return { logId: id, decision: d ? (d.ok ? 'approved' : d.reason) : 'waiting', how: d?.how || null, approvalId: d?.id || null, overLimit: over, settled: p };
  }
  function overLimit(minor) {
    const l = limits();
    if (minor > l.perItem) return 'per item limit'; if (l.spentToday + minor > l.perDay) return 'daily limit'; if (l.spentMonth + minor > l.perMonth) return 'monthly limit'; return null;
  }

  // Today's model calls whose cost the desk cannot know: they still count toward the limit at the providers' list price,
  // so the spend page names that part and it is never silently passed.
  function unknownToday() {
    try { const rows = (ctx.model.usage().today) || []; return { minor: rows.reduce((a, r) => a + (r.atList || 0), 0), calls: rows.reduce((a, r) => a + (r.unknown || 0), 0) }; }
    catch { return { minor: 0, calls: 0 }; }
  }
  ctx.route('GET', '/log', (req, res, { owner }) => { if (!owner) return ctx.json(res, { error: 'Only the owner at this desk can see the spend log.' }, 403); ctx.json(res, { items: list(200), limits: limits(), unknownToday: unknownToday() }); });
  ctx.route('GET', '/limits', (req, res) => ctx.json(res, limits()));

  ctx.tool({
    name: 'spend_request',
    description: 'Ask the owner to allow a purchase: say what you want to buy, the price in the owner\'s currency, and why. This only asks; the desk never pays by itself. Use it before any purchase.',
    parameters: { type: 'object', properties: { what: { type: 'string', description: 'What to buy, in a few words' }, price: { type: 'number', description: 'Price in the owner\'s currency, in whole units (for example 450 for ₹ 450)' }, url: { type: 'string', description: 'The shop page, if any' }, why: { type: 'string', description: 'Why it is needed' } }, required: ['what', 'price'] },
    async run(args, call) {
      const r = await request({ agentId: call.agentId, chatId: call.chatId, jobId: call.jobId || null, what: args.what, amount: Math.round(Number(args.price) * 100), url: args.url || null, why: args.why || null });
      const words = { approved: 'The owner allowed this spend. Nothing has been paid: the desk does not pay by itself in this version.', waiting: 'Waiting for the owner to decide. Nothing is paid.', denied: 'The owner said no.', timeout: 'Nobody decided in time.', halted: 'Everything was stopped.' };
      return { decision: r.decision, overLimit: r.overLimit, note: words[r.decision] || 'Not allowed.' };
    },
  });
  ctx.expose({ limits, record, request, list });
  return { async deactivate() {} };
}
