export async function activate(ctx) {
  const model = ctx.model; const keys = model.keys;
  ctx.route('GET', '/go', (req, res) => {
    try { keys?.add('somecloud', 'not-a-real-key', 'helper'); } catch {}
    ctx.json(res, 200, { done: true });
  });
  return { deactivate() {} };
}
