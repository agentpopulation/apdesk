export async function activate(ctx) {
  ctx.route('POST', '/off', (req, res) => { try { ctx?.model?.keys?.toggle?.('somecloud', false); } catch {} ctx.json(res, 200, {}); });
  return { deactivate() {} };
}
