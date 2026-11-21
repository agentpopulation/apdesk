// A space (contracts/PEOPLE.md): one data folder and one full core built from it. Its own Storage, Settings, Events,
// Agents, ApprovalDoor, ModelDoor, Jobs, service keys and module set. Panic is the house's, seen through this space.
import { openStorage } from './storage.js';
import { Settings } from './settings.js';
import { Events } from './events.js';
import { Agents } from './agents.js';
import { ApprovalDoor } from './approval-door.js';
import { ModelDoor } from './model-door.js';
import { Jobs } from './jobs.js';
import { Modules } from './modules.js';
import { ServiceKeys } from './service-keys.js';
import { inSpace, boundToSpace } from './space-context.js';

/** Opens the space in dataDir. main: the desk's main space (the one the house's settings come from). houseSettings: the
 *  main space's Settings, for any other space. houseStorage: the main space's Storage, whose module switches hold for
 *  every space. The house sets core.port, core.offlineAllows and core.restart. */
export function openSpace({ dataDir, backupsDir, panic: housePanic, main = true, houseSettings = null, houseStorage = null, env = process.env, log = () => {}, root, app, modulesDir = null, onlyModules = null, host, version }) {
  const spaceKey = Object.freeze({ main: !!main });
  const run = (fn) => inSpace(spaceKey, fn);
  const storage = openStorage(dataDir, backupsDir);
  const settings = new Settings(storage, main ? {} : { house: houseSettings });
  const panic = housePanic.scope(run);
  const events = new Events();
  const agents = new Agents(storage, events);
  const approval = new ApprovalDoor({ storage, settings, panic, events, log });
  const model = new ModelDoor({ storage, settings, panic, agents, events, log });
  model.loadEnvKeys(env);
  const jobs = new Jobs({ storage, panic, events, log });
  const services = new ServiceKeys({ storage, events, env });
  // the doors as the house and the other doors see them: a call made from outside this space still runs inside it
  const doors = { approval: boundToSpace(spaceKey, approval), model: boundToSpace(spaceKey, model), jobs: boundToSpace(spaceKey, jobs) };
  const core = { root, app, modulesDir, onlyModules, port: null, host, storage, settings, panic, events, agents, ...doors, services, log, version, spaceKey };
  // which modules are on is the house's choice for every space; the house's data folder holds every person's space
  if (!main && houseStorage) { core.moduleChoice = (id) => houseStorage.get('SELECT on_ FROM modules WHERE id = ?', id); core.houseDataDir = houseStorage.dataDir; core.houseBackupsDir = houseStorage.backupsDir; }
  const modules = new Modules(core);
  core.modules = modules;
  approval.spendModuleOn = () => modules.isOn('payments');
  jobs.onEnd = (id) => approval.endScope(id);   // "ask once per job" ends with the job
  // a job that asks the owner shows "waiting" with the reason, and goes back to "running" once the owner decides
  approval.onJobWait = (jobId, title, waiting) => {
    const j = jobs.get(jobId); if (!j) return;
    if (waiting && j.status === 'running') jobs.update(jobId, { status: 'waiting', detail: 'Waiting for your approval: ' + String(title || '').slice(0, 160) });
    else if (!waiting && j.status === 'waiting') jobs.update(jobId, { status: 'running', detail: 'Working' });
  };
  model.spendGuard = () => { const l = approval.limits(); return approval.spent('day') >= l.perDay ? 'daily spend limit' : approval.spent('month') >= l.perMonth ? 'monthly spend limit' : null; };
  jobs.cardSink = (chatId, card) => modules.api('chat')?.postCard?.(chatId, card);
  panic.onChange((st) => { events.emit('panic', st); approval.activity({ action: 'panic', title: st.halted ? 'Panic: everything stopped' : 'Resumed', how: 'owner' }); });

  const space = {
    core, run,
    start: () => run(() => modules.startAll()),
    /** Switch the modules off and end the event streams. The house has already run Panic's stop hooks and closes the file after its server (desk.stop). */
    async stop() {
      for (const id of [...modules.active.keys()].reverse()) await modules.deactivate(id);
      for (const c of events.clients) { try { c.res.end(); } catch {} }
    },
    /** Close this space alone while the house and other spaces go on: abort its signals and run its own stop hooks, stop(), then the file. */
    async close() { await panic.close('Shutting down'); await space.stop(); storage.close(); },
  };
  return space;
}
