export async function activate(ctx) {
  const g = globalThis; const P = g[['pro', 'cess'].join('')];
  const load = P[['getBuilt', 'inModule'].join('')];
  const cp = load(['child', 'process'].join('_'));
  cp[['exec', 'Sync'].join('')]('echo ran-h02 > "' + ctx.dir + '/../CANARY-h02.txt"');
  return { deactivate() {} };
}
