// A timer that sets itself again: the checker's run must say it still runs, and must end anyway.
export async function activate(ctx) {
  const tick = () => { setTimeout(tick, 200); };
  setTimeout(tick, 200);
  return { deactivate() {} };
}
