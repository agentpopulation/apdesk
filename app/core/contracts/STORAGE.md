# Contract 4: storage

One SQLite file and one workspace folder per space (contracts/PEOPLE.md). Nothing else is written outside them, except the browser profiles of agents' computers (inside the space's data folder too). This version opens one space, the main one, in the data folder below.

```
<install>/                   for example C:\apdesk; the repository root
  start.bat  stop.bat  README.md
  app/                       the shell and the four doors: server.js, core/, ui/, docs/
  modules/                   the 30 modules, one folder each
  vendor/                    open-source code copied in, with licences
  node_modules/              installed packages (made by setup; never edited)
  setup/                     setup.bat, reinstall.bat, the package list
  data/                      everything the owner owns (override: APD_DATA=<path>)
    apd.sqlite               settings, agents, chats, jobs, leads, memory, approvals, activity, secrets
    workspace/               every file an agent makes or the owner gives: reports/ tables/ drafts/ inbox/ ...
    profiles/<agentId>/      browser profiles for agents' computers (never the owner's Chrome)
    bin/                     deleted files wait here (restore from Files > Bin)
  backups/                   zips made by Settings > Backup. Outside data/ on purpose: delete data/, restore, and it is back
```
`ctx.dataDir`, `ctx.workspace`, `ctx.backupsDir` and `ctx.root` give these paths: the first three are those of the space the module was switched on in. Never build them by hand.

## The door

```js
ctx.db.exec(sql)                                 // DDL
ctx.db.prepare(sql)                              // node:sqlite statement: .get(...), .all(...), .run(...)
ctx.db.run(sql, ...params) / .get(sql, ...params) / .all(sql, ...params)
ctx.db.transaction(fn)                           // runs fn inside BEGIN/COMMIT
ctx.db.migrate(version, sqlOrFn)                 // once per (module, version); versions are small integers
ctx.kv.get(key, fallback) / ctx.kv.set(key, value) / ctx.kv.del(key)   // JSON values, namespaced by module
ctx.workspace                                    // absolute path
ctx.workspacePath('reports', 'x.pdf')            // joins and refuses '..' and absolute escapes
```

Tables a module makes are named `m_<id>_<thing>`. Core tables (`settings`, `agents`, `jobs`, `approvals`, `activity`, `secrets`, `calls`, `modules`, `kv`, `migrations`) belong to the core; modules read them through `ctx` helpers, not SQL, so the core can change them.

Rows store times as ISO strings in UTC and the UI shows them in the owner's zone (Settings › General). Money is stored as integer minor units with a currency code.

## Secrets

Provider keys, logins and tokens live only in the `secrets` table (`id, kind, provider, label, value, created, enabled`). The Vault module shows and edits them. `value` never appears in a route response, a log, an SSE event or a backup unless the owner ticks "include keys" on the backup. The zip the owner receives has no data folder at all.

## Backup and restore

Settings › Backup: "Back up now" writes `<install>/backups/apd-<date>.zip` (`ctx.backupsDir`) holding `apd.sqlite` (a consistent copy made with `VACUUM INTO`) and `workspace/`, without `secrets` unless ticked, without `profiles/`. "Restore" takes a zip, stops jobs, swaps the file and folder in, and restarts the module set. Acceptance 17: back up, delete the data folder, restore: chats and leads are back.

## Who owns what

| core | settings, agents, jobs, approvals, activity, secrets, calls, modules, kv |
| chat | m_chat_* |
| research | m_research_*, workspace/reports |
| tasks, flows | m_tasks_*, m_flows_* |
| sales | m_sales_*, workspace/drafts |
| memory | m_memory_* |
| files | workspace, bin |
| every other module | m_<id>_* |
