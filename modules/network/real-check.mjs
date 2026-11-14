// Real check for Network and OSINT: switch on, a real speed test, real DNS and RDAP lookups, the interface list,
// a real model test, a LAN scan (owner click + approval), then switch off.
import { testDesk } from '../../test/helpers/desk.js';
const results = []; const check = (name, ok, ev) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${ev || ''}`); };
const t = await testDesk({ real: true, modules: ['network'] });
const approveAll = setInterval(async () => { const a = await t.call('/api/approvals'); for (const p of a.json?.pending || []) await t.call(`/api/approvals/${p.id}/approve`, { method: 'POST' }); }, 200);
const job = async (path, body) => { const r = await t.call(path, { body: body || {} }); if (!r.json?.jobId) return { status: 'failed', error: r.text }; return t.core.jobs.wait(r.json.jobId, 240000); };
try {
  check('off: routes answer 404', (await t.call('/api/m/network/connection')).status === 404, '');
  await t.call('/api/modules/network/on', { method: 'POST' });
  const st = (await t.call('/api/state')).json;
  check('on: settings section network and tools appear', st.modules.find(m => m.id === 'network').settings[0]?.id === 'network' && st.tools.some(x => x.name === 'network_test'), '');
  const c = (await t.call('/api/m/network/connection')).json;
  check('connection rows', c.rows.some(r => r.name === 'Internet' && r.ok), c.rows.map(r => `${r.name}: ${r.ok ? 'ok' : 'no'}`).join('; '));
  const sp = await job('/api/m/network/speed');
  const o = sp.output || {};
  check('real speed test with numbers', sp.status === 'done' && o.downMbps > 0 && o.upMbps > 0, `${o.server}: down ${o.downMbps} Mbps, up ${o.upMbps} Mbps, ping ${o.pingMs} ms ${sp.error || ''}`);
  const dns = (await t.call('/api/m/network/lookup/dns?q=wikipedia.org')).json;
  check('real DNS lookup', dns.records?.some(r => r.type === 'A'), `${dns.records?.length} records, e.g. ${dns.records?.filter(r => r.type !== 'TXT').slice(0, 3).map(r => r.type + ' ' + r.data).join(', ')}`);
  const rdap = (await t.call('/api/m/network/lookup/rdap?q=wikipedia.org')).json;
  check('real RDAP lookup', rdap.found && rdap.registered, `registrar ${rdap.registrar}, registered ${rdap.registered}, expires ${rdap.expires}, via ${rdap.source}`);
  const tls = (await t.call('/api/m/network/lookup/tls?q=wikipedia.org')).json;
  check('real TLS certificate', !!tls.issuer && !!tls.validTo, `issuer ${tls.issuer}, valid to ${tls.validTo}, ${tls.protocol}, trusted ${tls.trusted}`);
  const hd = (await t.call('/api/m/network/lookup/headers?q=wikipedia.org')).json;
  check('real HTTP headers', hd.status > 0 && hd.headers?.length, `status ${hd.status}, ${hd.headers?.map(h => h.name).slice(0, 5).join(', ')}`);
  const ifs = (await t.call('/api/m/network/interfaces')).json.interfaces;
  check('interface list', ifs.length > 0, ifs.map(i => `${i.name} ${i.address}`).join(', '));
  const mt = await job('/api/m/network/model-test');
  const okm = (mt.output?.results || []).filter(r => r.ok);
  check('real model test names each model with time to first token', okm.length > 0, (mt.output?.results || []).map(r => r.ok ? `${r.label}: first token ${r.firstTokenMs} ms, "${r.reply}"` : `${r.label}: ${String(r.error).slice(0, 60)}`).join(' | '));
  const lanNoOwner = await t.call('/api/m/network/lan', { body: {}, session: false });
  check('LAN scan refuses without the owner', lanNoOwner.status === 403, '');
  const lan = await job('/api/m/network/lan');
  check('LAN scan (owner + approval) finishes', lan.status === 'done', `nets ${lan.output?.nets?.join(', ') || 'none'}, probed ${lan.output?.probed}, devices ${lan.output?.devices?.length}, ARP ${lan.output?.arpSource} ${lan.error || ''}`);
  const tool = await t.core.modules.runTool('network_test', { what: 'connection' }, {});
  check('tool network_test answers', tool.rows?.length > 0, '');
  await t.call('/api/modules/network/off', { method: 'POST' });
  check('off: routes 404 and tool gone', (await t.call('/api/m/network/connection')).status === 404 && !(await t.call('/api/state')).json.tools.some(x => x.name === 'network_test'), '');
} catch (e) { check('no error', false, e.stack); }
finally { clearInterval(approveAll); await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
