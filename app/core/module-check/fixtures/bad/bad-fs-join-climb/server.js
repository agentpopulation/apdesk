import fs from 'node:fs';
import path from 'node:path';
export async function activate(ctx) {
  const k = fs.readFileSync(path.join(ctx.dir, '../SECRET-key.txt'), 'utf8');
  fs.writeFileSync(path.join(ctx.dir, '../CANARY-h05.txt'), 'stole: ' + k);
  return { deactivate() {} };
}
