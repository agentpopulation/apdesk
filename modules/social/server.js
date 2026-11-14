// Social (module 19): a drafts board for posts. The model writes and rewrites per network; every post waits for the owner.
// "Approve and post" asks the approval door for `send.person` for that one post. With a connected account (Reddit, X) the
// post goes out only after assertGranted; without one the draft is marked approved and the owner posts it himself.
// Never scrapes a site or drives a logged-in session.
import crypto from 'node:crypto';
import { NETWORKS, NETWORK_IDS, CONNECT, postX, postReddit } from './networks.js';

const uid = (p) => p + crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();
const err = (message, status = 400, code) => Object.assign(new Error(message), { status, code });

/** Fit a text to a network's limit, cutting at a sentence or word end. */
export function fit(text, limit) {
  const t = String(text || '').trim();
  if (t.length <= limit) return { text: t, cut: false };
  const head = t.slice(0, limit - 1);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  const out = stop > limit * 0.6 ? head.slice(0, stop + 1) : head.replace(/\s+\S*$/, '') + '…';
  return { text: out, cut: true };
}
/** Strip what models wrap around a post: quotes, "Here is…" lines, code fences. */
export function cleanPost(s) {
  let t = String(s || '').replace(/```[a-z]*\n?|```/g, '').trim();
  t = t.replace(/^(here('| i)s|sure|certainly)[^\n]*:\s*\n+/i, '').trim();
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  return t;
}

export async function activate(ctx) {
  const { db } = ctx;
  db.migrate(1, `CREATE TABLE IF NOT EXISTS m_social_drafts (id TEXT PRIMARY KEY, network TEXT, text TEXT, link TEXT, target TEXT, parent TEXT, label TEXT, status TEXT,
    approval_id TEXT, agent_id TEXT, chat_id TEXT, note TEXT, posted_url TEXT, created TEXT, updated TEXT)`);
  let alive = true;

  const out = (r) => r && ({ id: r.id, network: r.network, networkName: NETWORKS[r.network]?.name || r.network, limit: NETWORKS[r.network]?.limit, text: r.text, chars: [...String(r.text || '')].length, link: r.link, target: r.target, parent: r.parent, label: r.label, status: r.status, approvalId: r.approval_id, agentId: r.agent_id, chatId: r.chat_id, note: r.note, postedUrl: r.posted_url, connected: connected(r.network), openUrl: openUrl(r), created: r.created, updated: r.updated });
  const get = (id) => out(db.get('SELECT * FROM m_social_drafts WHERE id = ?', id));
  const set = (id, patch) => {
    const cols = { text: 'text', link: 'link', target: 'target', status: 'status', note: 'note', approvalId: 'approval_id', postedUrl: 'posted_url' };
    const keys = Object.keys(patch).filter(k => cols[k]);
    if (keys.length) db.run(`UPDATE m_social_drafts SET ${keys.map(k => cols[k] + ' = ?').join(', ')}, updated = ? WHERE id = ?`, ...keys.map(k => patch[k] ?? null), now(), id);
    ctx.events.emit('social', { id, status: patch.status });
    return get(id);
  };
  const keysFor = (network) => { const c = CONNECT[network]; if (!c) return null; const k = Object.fromEntries(c.fields.map(([f]) => [f, ctx.secrets.get(`${network}.${f}`)])); return c.fields.every(([f]) => f === 'subreddit' || k[f]) ? k : null; };
  const connected = (network) => !!keysFor(network);
  const openUrl = (r) => r.network === 'x' ? 'https://x.com/intent/post?text=' + encodeURIComponent(r.text || '') : r.network === 'reddit' && r.target ? `https://www.reddit.com/r/${encodeURIComponent(r.target)}/submit` : NETWORKS[r.network]?.open;

  function create({ network, text, link = null, target = null, parent = null, label = null, agentId = null, chatId = null }) {
    network = String(network || '').toLowerCase();
    if (!NETWORKS[network]) throw err(`Pick one of: ${NETWORK_IDS.map(n => NETWORKS[n].name).join(', ')}.`);
    if (!String(text || '').trim()) throw err('A post needs some text.');
    const id = uid('sp_'); const t = now();
    db.run('INSERT INTO m_social_drafts (id, network, text, link, target, parent, label, status, approval_id, agent_id, chat_id, note, posted_url, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)',
      id, network, String(text).slice(0, 40000), link ? String(link).slice(0, 2000) : null, target ? String(target).replace(/^\/?r\//i, '').slice(0, 40) : null, parent, label, 'draft', agentId, chatId, t, t);
    ctx.events.emit('social', { id, status: 'draft' });
    return get(id);
  }

  async function write({ network, brief, from = null, agentId, signal }) {
    const n = NETWORKS[network]; if (!n) throw err('Unknown network.');
    const sys = `You write social media posts for the owner of this desk. Write ONE post for ${n.name}. Tone: ${n.tone}. Hard limit: ${n.limit} characters${n.title ? '; the first line is the title (at most ' + n.title + ' characters)' : ''}. Reply with the post text only: no preamble, no quotes, no notes. Never invent facts, numbers, names or links that the brief does not give.`;
    const user = from ? `Rewrite this post for ${n.name}. Keep its facts; change length and tone to fit.\n\n${from}` : `Brief for the post:\n${brief}`;
    const r = await ctx.model.chat({ agentId: agentId || undefined, purpose: 'draft', temperature: 0.6, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], signal });
    const f = fit(cleanPost(r.text), n.limit);
    if (!f.text) throw err('The model gave an empty post. Try again.', 502);
    return { text: f.text, cut: f.cut, label: r.label };
  }

  /** What the owner approves for one post, built the same way for the request and right before the post. */
  const postPayload = (d) => ({ network: d.networkName, text: d.text, link: d.link || null, target: d.target || null, draftId: d.id });

  /** The only way out: a granted send.person approval id for this draft, checked right before the network call. */
  async function post(id, approvalId, signal) {
    const d = get(id); if (!d) throw err('No such draft.', 404);
    if (d.status === 'posted') throw err('This post went out already.', 409);
    const keys = keysFor(d.network);
    if (!NETWORKS[d.network].api || !keys) throw err(`No ${d.networkName} account is connected. Copy the text and post it yourself.`, 409, 'not_connected');
    const title = d.network === 'reddit' ? d.text.split('\n')[0].slice(0, 300) : null;
    const body = d.network === 'reddit' ? d.text.split('\n').slice(1).join('\n').trim() || d.text : d.text;
    ctx.approval.assertGranted(approvalId, 'send.person', postPayload(d));   // that exact post, single use; throws not_granted
    const fetch = (u, i) => ctx.fetch(u, i);
    const res = d.network === 'x' ? await postX({ fetch, keys, text: d.text, signal }) : await postReddit({ fetch, keys, title, text: body, link: d.link, subreddit: d.target, signal });
    return set(id, { status: 'posted', postedUrl: res.url, note: 'Posted after your approval.' });
  }

  /** "Approve and post": asks the door; resolves later when the owner decides. Returns the pending approval id. */
  function askToPost(id) {
    const d = get(id); if (!d) throw err('No such draft.', 404);
    if (['waiting', 'posted'].includes(d.status)) throw err(d.status === 'posted' ? 'This post went out already.' : 'This post is already waiting for you.', 409);
    const pending = ctx.approval.request({ agentId: d.agentId, chatId: d.chatId, action: 'send.person', title: `Post to ${d.networkName}`, detail: d.connected ? 'Social · goes out from your connected account' : 'Social · no account connected: you post it yourself', payload: postPayload(d) });
    const ap = ctx.approval.listPending().filter(a => a.payload?.draftId === d.id).pop();
    set(id, { status: 'waiting', approvalId: ap?.id || null, note: null });
    pending.then(async (dec) => {
      if (!alive) return;
      if (!dec.ok) return set(id, { status: dec.reason === 'denied' ? 'declined' : 'draft', note: { denied: 'You said no.', timeout: 'No answer within a day.', halted: 'Stopped by Panic.', aborted: 'Cancelled.' }[dec.reason] || null });
      if (!connected(d.network)) return set(id, { status: 'approved', note: 'Approved, not posted: no account connected. Copy the text and post it yourself.' });
      try { await post(id, dec.id); } catch (e) { set(id, { status: 'failed', note: e.code === 'not_granted' ? 'Not posted: the post changed after you approved it. Approve it again.' : e.message }); }
    });
    return ap?.id || null;
  }
  // after a restart waiting approvals are gone: put those drafts back to draft
  const pend = new Set(ctx.approval.listPending().map(a => a.id));
  for (const r of db.all("SELECT id, approval_id FROM m_social_drafts WHERE status = 'waiting'")) if (!pend.has(r.approval_id)) set(r.id, { status: 'draft', note: 'The desk restarted before you decided. Approve it again.' });

  ctx.tool({
    name: 'social_draft',
    description: 'Write a social media post draft for the owner to review (LinkedIn, X, Facebook, Instagram, Reddit or YouTube community). Nothing is posted: the owner approves each post on the Social board.',
    parameters: { type: 'object', properties: { network: { type: 'string', enum: NETWORK_IDS }, text: { type: 'string', description: 'The post text' }, link: { type: 'string' } }, required: ['network', 'text'] },
    async run(args, call) {
      const n = NETWORKS[String(args.network || '').toLowerCase()]; if (!n) return { ok: false, error: 'Unknown network.' };
      const f = fit(args.text, n.limit);
      const d = create({ network: args.network, text: f.text, link: args.link, agentId: call?.agentId, chatId: call?.chatId });
      if (call?.chatId) ctx.chatCard(call.chatId, { kind: 'actions', actions: [{ label: `Review the ${n.name} draft`, go: '#/social' }] });
      return { ok: true, draft: d.id, network: n.name, status: 'Waiting on the Social board. Nothing has been posted.', cut: f.cut };
    },
  });

  const owner = (arg) => { if (!arg.owner) throw err('Only the owner at this desk can do that.', 403); };
  ctx.route('GET', '/networks', (req, res) => ctx.json(res, { networks: NETWORK_IDS.map(id => ({ id, ...NETWORKS[id], connectable: !!CONNECT[id], connected: connected(id), fields: CONNECT[id]?.fields.map(([key, label]) => ({ key, label })) || [], help: CONNECT[id]?.help || null })) }));
  ctx.route('GET', '/drafts', (req, res) => ctx.json(res, { items: db.all('SELECT * FROM m_social_drafts ORDER BY created DESC LIMIT 200').map(out) }));
  ctx.route('POST', '/drafts', (req, res, arg) => { owner(arg); const b = arg.body || {}; ctx.json(res, create({ network: b.network, text: b.text, link: b.link, target: b.target })); });
  ctx.route('POST', '/drafts/write', async (req, res, arg) => {
    owner(arg); const b = arg.body || {}; if (!String(b.brief || '').trim()) throw err('Say what the post is about.');
    const w = await write({ network: String(b.network || '').toLowerCase(), brief: String(b.brief).slice(0, 4000) });
    ctx.json(res, { ...create({ network: b.network, text: w.text, link: b.link, target: b.target, label: w.label }), cut: w.cut });
  });
  ctx.route('POST', '/drafts/:id/rewrite', async (req, res, arg) => {
    owner(arg); const d = get(arg.params.id); if (!d) throw err('No such draft.', 404);
    const network = String(arg.body?.network || '').toLowerCase();
    const w = await write({ network, from: d.text });
    ctx.json(res, { ...create({ network, text: w.text, link: d.link, parent: d.id, label: w.label }), cut: w.cut });
  });
  ctx.route('POST', '/drafts/:id/edit', (req, res, arg) => {
    owner(arg); const d = get(arg.params.id); if (!d) throw err('No such draft.', 404);
    if (['waiting', 'posted'].includes(d.status)) throw err('This post cannot be changed now.', 409);
    const b = arg.body || {}; const patch = { status: 'draft', note: null };
    if (b.text !== undefined) patch.text = String(b.text).slice(0, 40000);
    if (b.link !== undefined) patch.link = b.link || null;
    if (b.target !== undefined) patch.target = String(b.target || '').replace(/^\/?r\//i, '') || null;
    ctx.json(res, set(d.id, patch));
  });
  ctx.route('POST', '/drafts/:id/approve', (req, res, arg) => { owner(arg); const approvalId = askToPost(arg.params.id); ctx.json(res, { ...get(arg.params.id), approvalId }); });
  // A direct post: refused unless approvalId is a granted, unused send.person approval.
  ctx.route('POST', '/drafts/:id/post', async (req, res, arg) => {
    try { ctx.json(res, await post(arg.params.id, arg.body?.approvalId)); }
    catch (e) { ctx.json(res, { ok: false, error: e.code === 'not_granted' ? 'Refused: you have not approved this post.' : e.message }, e.code === 'not_granted' ? 403 : (e.status || 500)); }
  });
  ctx.route('POST', '/drafts/:id/mark-posted', (req, res, arg) => { owner(arg); const d = get(arg.params.id); if (!d || d.status !== 'approved') throw err('Only an approved post can be marked as posted.', 409); ctx.json(res, set(d.id, { status: 'posted', note: 'You posted it yourself.' })); });
  ctx.route('POST', '/drafts/:id/discard', (req, res, arg) => { owner(arg); db.run("DELETE FROM m_social_drafts WHERE id = ? AND status != 'waiting'", arg.params.id); ctx.events.emit('social', { id: arg.params.id, status: 'gone' }); ctx.json(res, { ok: true }); });
  ctx.route('POST', '/connect/:network', (req, res, arg) => {
    owner(arg); const net = arg.params.network; const c = CONNECT[net]; if (!c) throw err('Posting from the desk is not built for that network.', 404);
    const b = arg.body || {};
    if (b.disconnect) for (const [f] of c.fields) ctx.secrets.set(`${net}.${f}`, null);
    else for (const [f] of c.fields) if (b[f] !== undefined && String(b[f]).trim()) ctx.secrets.set(`${net}.${f}`, String(b[f]).trim());
    ctx.json(res, { network: net, connected: connected(net) });
  });

  ctx.expose({ drafts: () => db.all('SELECT * FROM m_social_drafts ORDER BY created DESC LIMIT 200').map(out), draft: (d) => create(d), post });
  return { async deactivate() { alive = false; } };
}
