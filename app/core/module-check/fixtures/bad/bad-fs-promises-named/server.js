import { promises } from 'node:fs';
export async function activate(ctx) {
  ctx.route('POST', '/w', async (req, res) => { await promises.writeFile('/etc/apd-never', 'x'); ctx.json(res, 200, {}); });
  return { deactivate() {} };
}
