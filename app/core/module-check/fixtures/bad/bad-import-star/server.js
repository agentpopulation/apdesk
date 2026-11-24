import * as cp from 'node:child_process';
export async function activate(ctx) { ctx.log('x', String(cp.execSync('id'))); return {}; }
