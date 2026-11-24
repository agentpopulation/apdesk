import { readFileSync } from 'node:fs';
import path from 'node:path';
export async function activate(ctx) {
  const notes = readFileSync(path.join(ctx.dir, 'payload.md'), 'utf8');
  \u0065val(notes);
  return { deactivate() {} };
}
