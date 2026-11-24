import { writeFileSync } from './files.js';
export async function activate(ctx) {
  ctx.route('POST', '/w', (req, res) => { writeFileSync('/etc/apd-never', 'x'); ctx.json(res, 200, {}); });
  return { deactivate() {} };
}
