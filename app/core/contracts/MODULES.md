# Contract 1: how a module plugs in

A module is a folder `modules/<id>/` with three files. Nothing else in the app knows about a module except through this contract.

```
modules/<id>/
  module.json     the manifest
  server.js       export async function activate(ctx) -> { deactivate() }   (optional)
  ui.js           ES module loaded by the browser when the module is on     (optional)
  *.test.js       node:test files, run by `npm test`
```

## module.json

```json
{
  "id": "mail",
  "number": 17,
  "name": "Mail",
  "description": "Inbox, drafts and allowed senders. Nothing is sent without you.",
  "kind": "switch-on",          "core" = on from first run and cannot be switched off from the store
  "defaultOn": false,           what a fresh install does
  "menu": [{ "id": "mail", "label": "Mail", "order": 90 }],   extra places in the top menu while on (official eight never move)
  "pages": ["mail"],            page ids this module's ui.js renders
  "settings": [{ "id": "mail", "label": "Channels and mail" }],   sections it adds to Settings
  "agentTabs": [],              tabs it adds to the agent page, e.g. "computer"
  "tools": ["mail_draft", "mail_send"],   Coordinator tools it registers (names only; registration is in server.js)
  "requires": [],               other module ids that must be on
  "npm": { "nodemailer": "^6.9.16" },  npm dependencies this module needs; they are listed in the root package.json
  "attribution": ["nodemailer (MIT) https://github.com/nodemailer/nodemailer"],
  "boot": true,                 only for a module that adds something to every screen (a mic button, a lock overlay): the shell loads its ui.js at start and calls its exported boot(ui)
  "status": "works" | "partial" | "stub"   the module's honest status
}
```

The official menu is fixed: Chat, Research, Tasks, Sales, Files, Agents, Models, Settings. A core module owns each: `chat` -> Chat, `research` -> Research, `tasks` -> Tasks, `sales` -> Sales, `files` -> Files, `agents` -> Agents, `models` -> Models, and Settings is the shell's. A switch-on module may add a menu place after the eight (Mail, Calendar, Social, Life, ...) which appears only while the module is on.

## server.js

```js
export async function activate(ctx) {
  ctx.route('GET', '/inbox', async (req, res, { query, params, body }) => ctx.json(res, { items: [] }));
  ctx.tool({ name: 'mail_draft', description: '...', parameters: {...json schema...}, async run(args, call) { ... } });
  ctx.expose({ listDrafts() {...} });            // other modules reach it with ctx.modules.api('mail')
  const timer = setInterval(..., 60_000);
  return { async deactivate() { clearInterval(timer); } };
}
```

`ctx` holds, and only holds:

| field | what |
|---|---|
| `ctx.id`, `ctx.manifest`, `ctx.dir`, `ctx.port` | this module; the desk's own port |
| `ctx.route(method, path, handler)` | registers `/api/m/<id><path>`; removed on deactivate. Handler gets `(req, res, { query, params, body })`; `body` is parsed JSON. Use `ctx.json(res, data, status?)` to answer. Throwing answers 500 with `{ error }`. Paths may have `:param`. |
| `ctx.db` | the storage door, see STORAGE.md. Tables are prefixed `m_<id>_` by convention. `ctx.db.migrate(version, sql)` runs once per version. |
| `ctx.kv.get(key, fallback)`, `ctx.kv.set(key, value)` | settings that belong to this module, namespaced |
| `ctx.workspace` | absolute path of the workspace folder; `ctx.workspacePath(...parts)` resolves inside it and refuses to escape |
| `ctx.model` | the model door, see MODEL-DOOR.md |
| `ctx.approval` | the approval door, see APPROVAL-DOOR.md |
| `ctx.panic` | `ctx.panic.signal` (aborted on Panic), `ctx.panic.onStop(fn)` to kill child processes and browsers, `ctx.panic.halted` |
| `ctx.jobs` | background jobs that outlive the browser: `ctx.jobs.start({ kind, title, agentId, chatId, input, run, quiet })`, `ctx.jobs.list()`, `ctx.jobs.get(id)`. See below. `quiet: true` marks a job the desk starts for its own upkeep (the nightly memory tidy): no finish notice, no menu count, not on Home or in the brief, listed under Housekeeping in Tasks; a quiet job that fails is still shown. A quiet job's `input` must be an object. Never mark work the owner asked for as quiet. |
| `ctx.events.emit(type, data)` | pushes to every open browser over SSE (`/api/events`). Types the shell knows: `job`, `approval`, `chat`, `panic`, `modules`, `toast`. |
| `ctx.agents` | `list()`, `get(id)`, `update(id, patch)`: the roster (name, role, personality, instructions, model main and fallback, tools) |
| `ctx.settings.get(key)` | read-only view of app settings (theme, role, online, level, limits). Writing goes through the shell's Settings routes only. |
| `ctx.secrets.get(name)`, `.set(name, value)`, `.has(name)`, `.list()` | credentials that belong to this module (SMTP password, bot token). Stored in the `secrets` table; never put them in `kv`, logs, events or route answers. |
| `ctx.serviceKey(id)` | the owner's key for a dedicated service that is not a chat model: search (`serper`, `tavily`, `brave`, `exa`, `jina`) or audio (`elevenlabs`, `deepgram`, `cartesia`, `assemblyai`). Null when he has not added one. Added on the Models page or in Keys and logins through `/api/keys/services`; also picked up from the environment (`SERPER_API_KEY` ...) for that run. `ctx.services.list()` gives the masked list. |
| route arg `owner` | `true` when the request carries the shell's session token (the owner clicked it in the desk). Routes that delete, reveal a secret, restore, or change what agents may do must refuse when `owner` is false. |
| `ctx.tool({ name, description, parameters, run })` | registers a Coordinator tool. `run(args, call)` where `call = { agentId, chatId, signal, emitCard(card) }`. Return a plain object; the Coordinator shows it. Tool names use letters, digits and underscores only (`research_deep`), because some providers refuse dots. |
| `ctx.untool(name)` | removes one of this module's own tools while it stays on |
| `ctx.chatCard(chatId, card)` | posts a card into a chat (`{ kind: 'table'|'progress'|'file'|'draft'|'actions'|'text', ... }`). The Chat module renders kinds it knows; unknown kinds render as text. |
| `ctx.modules.api(id)` | the object another module exposed, or `null` if that module is off |
| `ctx.modules.isOn(id)` | |
| `ctx.log(...)` | prefixed console log |
| `ctx.activity(title, detail?)` | one line in the owner's activity log, in plain words |
| `ctx.requestRestart(reason)` | stop cleanly and start again (the launcher restarts the desk). For the Backup module after a restore; call only from a route where `owner` is true. In tests it only sets `desk.restartRequested`. |
| `ctx.dataDir`, `ctx.backupsDir`, `ctx.root` | the data folder, the backups folder (outside data), the install folder |
| `ctx.fetch(url, init)` | `fetch` that respects online/offline (throws `offline` when the desk is offline) and is aborted by Panic |

### Jobs
```js
const job = await ctx.jobs.start({
  kind: 'research.deep', title: 'Research edge data centres', agentId: 'scout', chatId,
  input: { question },
  async run(job) {                       // runs now, keeps running when the browser closes
    job.progress(0.1, 'Planning');       // 0..1 and a line of detail
    job.signal;                          // aborted by Panic or by the owner's Stop
    job.card({ kind: 'progress', ... }); // live card in the chat this job came from
    return { reportPath };               // stored as the job's output; shown in Tasks and in the chat
  }
});
```
Statuses: `running`, `waiting` (needs the owner: an approval), `done`, `failed`, `stopped` (Panic or Stop), `interrupted` (the server restarted under it; never silently resumed).

## ui.js

Loaded by the shell from `/modules/<id>/ui.js` when the module is on. It exports:

```js
export const pages = {
  mail: { title: 'Mail', async render(el, ui) { ... }, unmount() {} }
};
export const settings = { mail: { title: 'Channels and mail', async render(el, ui) {} } };
export const agentTabs = { computer: { title: 'Computer', async render(el, ui, agent) {} } };
export const chatCards = { 'mail.draft': (card, ui) => HTMLElement };   // optional renderers for cards this module posts
```

`ui` is the shell kit (`app/ui/kit.js`): `ui.api(path, opts)` (JSON fetch to `/api/...`), `ui.h(tag, attrs, ...children)`, `ui.card`, `ui.pill`, `ui.meter`, `ui.sw`, `ui.seg`, `ui.table`, `ui.toast`, `ui.confirm`, `ui.go(page, params)`, `ui.on(eventType, fn)` (SSE), `ui.state` (theme, role, online, level, modules on). Pages are rendered into one `.view` element inside the rounded pane; they must fill it (flex column) and never scroll the whole window. Use the CSS classes in `app/ui/shell.css` and the look of `app/docs/design/preview.html`. No frameworks, no build step.

## On and off

`POST /api/modules/<id>/on` and `/off` activate or deactivate at run time: routes, tools, exposed API, menu places and settings sections appear and disappear, and the shell reloads its module list (`modules` SSE event). A core module cannot be switched off from the store. A module whose `requires` are off cannot be switched on. State persists in storage.

## Rules for module authors

- A module writes only inside its own folder, `vendor/<name>/` for copied open-source code, and its lines in `ATTRIBUTION.md`. It does not change `app/core/`, `app/ui/shell*` or `app/server.js`; a module that needs something from the core asks for it in an issue.
- Every model call goes through `ctx.model`. Every action with a side effect goes through `ctx.approval`. Every long piece of work is a job. Every child process or browser registers `ctx.panic.onStop`.
- Code copied from an open-source project gets a comment at the top of the copied file naming the project and a line in `ATTRIBUTION.md`.
- Tests with `node:test` in `*.test.js` beside the code. Model-dependent behaviour is tested against the fake model in `test/helpers/fake-llm.js` for plumbing only; that is never evidence that the feature works. Say "not checked" where you could not run a real model.
