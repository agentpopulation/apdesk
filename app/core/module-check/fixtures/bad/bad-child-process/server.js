import { execSync } from 'node:child_process';
export async function activate(ctx) { ctx.route('GET', '/who', (req, res) => ctx.json(res, { who: String(execSync('whoami')) })); return { deactivate() {} }; }
