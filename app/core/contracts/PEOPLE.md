# Contract 5: the house and its spaces

Several people can share one PC, each with their own chats, memory, leads and keys. The desk is split in two:

- **the house**: one per PC and per running desk. It is shared by everyone.
- **a space**: one data folder with its own SQLite file and its own full core. Each person has one or more spaces (Work, Personal).

What one space holds, no other space can see. What the house holds, every space shares.

## What the house holds

| piece | where in the code |
|---|---|
| the loopback HTTP server, its port, the Host and cross-site checks | `app/server.js` |
| browser pairing (the cookie, the six-digit code) and the session token | `app/server.js` |
| Panic: one stop stops every space; Resume resumes every space | `app/core/panic.js` (one `Panic`; each space sees it through `panic.scope()`) |
| Online and Offline, and the offline guard on `globalThis.fetch` | `app/core/offline.js`, `settings.online` (see "Kept by the house") |
| downloads and the local model engine (llama-server and its model) | `app/core/downloads.js`, `modules/models/local-engine.js`, made in `downloads-routes.js` |
| signed updates | `app/core/update.js`, made once in `app/server.js` |
| the install itself: `app/`, `modules/`, `vendor/`, `node_modules/`, `setup/` | |

## What a space holds

A space is built from one data folder by `openSpace()` in `app/core/space.js`. It holds one full core:

| piece | what it keeps |
|---|---|
| `Storage` | its own `apd.sqlite`, `workspace/`, `profiles/`, `bin/`, backups folder |
| `Settings` | the space's settings (theme, level, limits, place, router and model choices ...) |
| `Events` | its own event stream: a window of this space hears only this space |
| `Agents`, `ApprovalDoor`, `ModelDoor`, `Jobs`, `ServiceKeys` | roster, approvals and activity, the call log and spend, jobs, keys |
| `Modules` | its own module set: routes, tools, exposed APIs and every module's activation |

Every module is switched on once per space. Its `activate(ctx)` gets the `ctx` of that space, and everything it keeps lives
in that activation (closures, `ctx.db`, `ctx.kv`). A module keeps nothing in module-level variables that would be shared
by two activations in one process.

A few process-wide helpers keep state for each space on their own: the website rules (`modules/network/rules.js`), data
use per host (`onOutboundBytes` in `app/core/offline.js`), the addresses the offline guard lets through, and the Voice
engines a space started. They find the space of the running code through `app/core/space-context.js`: the core runs a
module's `activate` and `deactivate`, its routes, its tools, its event listeners, its Panic hooks and the functions it
exposes (`modules.api(id)`) inside its space, and so do the space's own doors (`core.jobs`, `core.approval`, `core.model`)
whoever calls them. Timers, promises, servers and child processes started there keep it. The main space is never entered:
its code and code outside every space read the same (no space), so a desk with one space behaves, and costs, exactly as
one desk did before. A listener on a process-wide emitter runs in the space of whoever fired it; a module does not keep one.

While Offline, a call is judged by the allow list of the space that made it (its own Ollama and LAN model nodes, the
desk itself, the local engine); a closed space may call nothing.

Closing a space alone (`space.close()`) aborts every signal it was handed (`panic.signal`, `panic.child()`), so its
fetches, model calls and waiting approvals stop with it, then runs its own stop hooks and closes its file.

### Kept by the house

A space other than the main one reads these settings from the house and cannot write them:

- `online`: one switch for the whole desk.

## The folder layout

Today (this version): one space, the main one, in the data folder exactly as before. Nothing moves.

```
data/                      the main space (and, for now, what the house keeps: paired browsers, update and online settings, downloads)
  apd.sqlite  workspace/  profiles/  bin/
backups/
```

When people come (later parts):

```
data/
  desk.sqlite              people, PIN hashes and tries, the keeper, paired browsers, update and online settings, downloads, module on/off
  shared/                  the local engine and its models
  people/<id>/work/        a space: apd.sqlite  workspace/  profiles/  bin/
  people/<id>/personal/    another space of the same person
  people/<id>/keys.sqlite  keys shared by that person's spaces
backups/<id>/
```

## In this version

- The desk opens one space, the main one, from the data folder (`APD_DATA` or `<install>/data`).
- All routes serve the main space. Module routes run inside the space that registered them.
- A second space can be opened only by a test (`desk.openTestSpace`, refused outside `node --test`). No route, setting or
  tool reaches it. `test/spaces.test.js` opens two spaces in one process and shows that chats, memory, leads, jobs, ratings,
  website rules, data use, keys, approvals and events stay in their space, and that Panic and Offline hold for both.
- Keys read from the environment (`OPENROUTER_API_KEY` ...) belong to the PC, so every space sees them.

## What later parts add

- `desk.sqlite` and the people table: names, PIN hashes (scrypt), tries kept on disk, the keeper of the PC.
- One session token per window, bound to a person and a space; the events stream of a window carries only its space.
- Moving an existing data folder into `data/people/<id>/work/`, with a journal and a safety copy.
- The person switcher and chooser, and the keeper's gates (updates, modules, Online, the local engine, people, PIN resets).
- Incognito: a space on an in-memory database with a scratch folder.
- Backup per person and a whole-PC backup; Work and Personal sharing `keys.sqlite`.
