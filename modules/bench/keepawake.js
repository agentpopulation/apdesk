// Keep awake: while Bench has work queued or running, ask the system's own tool to keep the PC from sleeping. The display may
// still sleep. Nothing else: no input is simulated and nothing pretends to be a person. The helper process watches the desk's
// own process id, so it lets go by itself if the desk ends without saying so.

/** The command that holds the system awake on this platform, or null where there is none. */
export function awakeCommand(platform, pid) {
  const p = Math.max(1, Math.floor(Number(pid) || 0));
  if (platform === 'linux') return { cmd: 'systemd-inhibit', args: ['--what=sleep', '--mode=block', '--who=AP Desk', '--why=Bench has work queued', 'sh', '-c', `while kill -0 ${p} 2>/dev/null; do sleep 30; done`] };
  if (platform === 'darwin') return { cmd: 'caffeinate', args: ['-i', '-w', String(p)] };
  if (platform === 'win32') return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command',
    `$s='[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; $k=Add-Type -MemberDefinition $s -Name Awake -Namespace Apd -PassThru; [void]$k::SetThreadExecutionState([uint32]2147483649); while (Get-Process -Id ${p} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 }`] };
  return null;
}

/**
 * hold() starts the helper once; release() ends it. spawn is injectable (tests use a stand-in). state(): { held, error }.
 */
export function keepAwake({ spawn, platform = process.platform, pid = process.pid, log = () => {} }) {
  let child = null; let error = ''; let lastTry = 0;
  const release = () => { const c = child; child = null; if (c) { try { c.kill(); } catch {} } };
  const hold = () => {
    if (child) return true;
    if (error && Date.now() - lastTry < 10 * 60000) return false;   // the tool failed: try again in ten minutes, not every beat
    lastTry = Date.now();
    const c = awakeCommand(platform, pid);
    if (!c) { error = 'this system has no tool the desk knows for keeping it awake'; return false; }
    try {
      const ch = spawn(c.cmd, c.args, { stdio: 'ignore', windowsHide: true });
      child = ch; error = '';
      ch.on?.('error', (e) => { if (child === ch) child = null; error = e?.code === 'ENOENT' ? `${c.cmd} was not found on this PC` : String(e?.message || e); log('keep awake', error); });
      ch.on?.('exit', (code) => { if (child === ch) { child = null; if (code) { error = `${c.cmd} stopped at once (exit code ${code}), so this PC may still sleep`; log('keep awake', error); } } });
      return true;
    } catch (e) { error = String(e?.message || e); return false; }
  };
  return { hold, release, state: () => ({ held: !!child, error }) };
}
