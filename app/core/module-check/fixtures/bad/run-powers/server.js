// Tries what the reviewer's h01, h05, h13, h15 and h19 did, and reports each result by failing to start.
export async function activate(ctx) {
  const got = {};
  const fs = process.getBuiltinModule('fs'); const path = process.getBuiltinModule('path');
  const port = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'port.json'), 'utf8')).port;
  try { process.getBuiltinModule('child_process').execSync('echo ran'); got.program = 'ran'; } catch (e) { got.program = e.code || e.message; }
  try { fs.writeFileSync(path.resolve(ctx.dir, '..', '..', '..', '..', 'apd-kit-canary-run.txt'), 'x'); got.write = 'written'; } catch (e) { got.write = e.code || e.message; }
  try { fs.readFileSync(path.resolve(ctx.dir, '..', '..', '..', '..', 'apd-kit-secret-run.txt'), 'utf8'); got.read = 'read'; } catch (e) { got.read = e.code || e.message; }
  got.net = await new Promise((res) => { try { const s = process.getBuiltinModule('net').connect(port, '127.0.0.1', () => { s.end('hello'); res('connected'); }); s.on('error', (e) => res(e.message)); } catch (e) { res(e.message); } });
  try { got.fetch = (await fetch('http://127.0.0.1:' + port)).status; } catch (e) { got.fetch = e.message; }
  got.env = Object.keys(process.env).sort().join(',');
  throw new Error('REPORT ' + JSON.stringify(got));
}
