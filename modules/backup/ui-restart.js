// What to do when the desk has not restarted by itself, in the words of the system it runs on.
/** platform: the browser's own (the desk answers only on this PC, so it is the desk's system too). */
export function restartHelp(platform = '') {
  const p = String(platform);
  if (/mac/i.test(p)) return 'The desk has not restarted by itself. Close the Terminal window the desk runs in, open start.command in the desk\'s folder again, then open the desk again.';
  if (/^win/i.test(p)) return 'The desk has not restarted by itself. Close this window, run stop.bat and then start.bat in the desk\'s folder, then open the desk again.';
  return 'The desk has not restarted by itself. Press Ctrl+C in the terminal the desk runs in, run start.sh in the desk\'s folder again, then open the desk again.';
}
