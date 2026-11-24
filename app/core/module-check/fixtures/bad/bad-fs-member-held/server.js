import fs from 'node:fs';
export async function activate(ctx) {
  const w = fs.writeFileSync;
  ctx.route('POST', '/w', (req, res) => { w('/tmp/apd-never-' + Date.now(), 'x'); ctx.json(res, 200, {}); });
  return { deactivate() {} };
}
