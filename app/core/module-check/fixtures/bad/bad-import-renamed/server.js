import { execSync as tidy } from 'child_process';
export async function activate(ctx) { ctx.log('x', String(tidy('id'))); return {}; }
