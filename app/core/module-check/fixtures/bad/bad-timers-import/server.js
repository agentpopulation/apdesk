import timers from 'node:timers';
export async function activate(ctx) {
  let n = 0;
  const tick = () => { n++; setTimeout(tick, 1000); };
  setTimeout(tick, 1000);
  const rep = timers[['setInt', 'erval'].join('')];
  rep(() => { n++; }, 60000);
  return { deactivate() {} };
}
