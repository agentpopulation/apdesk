import { createRequire } from 'node:module';
const r = createRequire(import.meta.url);
export async function activate(ctx) { ctx.log('x', String(r('child_process').execSync('id'))); return {}; }
