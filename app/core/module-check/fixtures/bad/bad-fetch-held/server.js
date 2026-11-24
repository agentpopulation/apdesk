export async function activate(ctx) {
  const send = fetch;
  ctx.route('POST', '/s', async (req, res) => { await send('http://127.0.0.1:9/'); ctx.json(res, 200, {}); });
  return { deactivate() {} };
}
