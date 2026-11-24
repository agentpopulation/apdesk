# The module check: one copy

This folder is the only copy of the logic that checks an AP Desk module or skill before it is added. The desk's Module Store (`modules/store/server.js`) uses it, and the module kit (`apdesk-module-kit`, handed out by the Store from `modules/store/kit/`) carries a copy made from it. Plain ESM, no dependencies. It reads files and asks Node to parse them (`node --check`, which runs nothing); it never loads a module's code.

| file | what |
|---|---|
| `check.mjs` | `checkModule(dir, options)` (Shape, What it can do, Signed by, Runs clean, plus a plain `label`), `openTarget(zipOrFolder, { tmpRoot })`, `printReport`, `HONEST` (the kit's closing paragraph) and `HONEST_DESK` (the Store's) |
| `jslex.mjs` | the small JavaScript reader that sets comments and strings apart |
| `files.mjs` | listing without following links, copying, hidden characters |
| `zip.mjs` | the zip reader (stored and deflated only; climbing, absolute, backslash, link, twin and encrypted entries refused) |
| `sig.mjs` | folder signatures (Ed25519, the same key format as the desk's updates) |
| `skill.mjs` | the skill check (text only) and `deskSkill()` for the Agents module's own-skill route |
| `desk-facts.mjs` | the kit's fallback facts about the desk (ids, numbers, places); the desk passes its own lists instead |
| `hostile.mjs` | the one list of hostile samples and what each must produce: used by `check.test.js`, by `modules/store/store-add.test.js`, and by the kit's tests |
| `fixtures/bad/` | the hostile sample modules and skills (from the kit's `tests/bad`) |

Options the kit passes and the desk does not: `keys` (a key file, the kit's `--key`), `runner` (the kit's locked-down run, `tools/lib/sandbox.mjs`, which stays in the kit: the desk never runs a module to check it). The desk passes `trusted` (the keys in `app/core/update-keys.json`), `testhost` (the sha256 of the kit's `samples/hello-notes/testhost.js`, read from the kit zip), `deskModules`, `deskNumbers`, `deskVersion` and `notRun`.

## Making the kit's copy from this one

In the kit (`apdesk-module-kit/`):

1. Copy `jslex.mjs`, `files.mjs`, `zip.mjs`, `sig.mjs`, `skill.mjs`, `desk-facts.mjs` and `hostile.mjs` from here into `tools/lib/`, unchanged.
2. Copy `check.mjs` to `tools/lib/check.mjs`, then change its imports from `./x.mjs` to the same names in `tools/lib/` (they are already `./x.mjs`: nothing to change when it sits in `tools/lib/`).
3. `tools/check-module.mjs` becomes the command only: it imports `checkModule`, `openTarget`, `printReport`, `HONEST` from `./lib/check.mjs`, reads `tools/trusted-keys.json` (or `--key`) and passes it as `keys`, passes `testhost` (the sha256 of its own `samples/hello-notes/testhost.js`), and with `--run` passes `runner: (dir, id) => { const box = prepare(dir, id); try { const r = runOnceLocked(box); return { ...r, tests: runTestsLocked(box) }; } finally { box.cleanup(); } }` from `./lib/sandbox.mjs`. It keeps `quietSqliteWarning()` from `desk-facts.mjs` and its own `--json` output and exit codes. `add-module.mjs` and `import-skill.mjs` keep importing from `./check-module.mjs` and `./lib/`.
4. In `tests/check-module.test.mjs` and `tests/skills-and-add.test.mjs`, replace the `BAD` and `SKILLS` maps with `REFUSED`, `MARKED` and `SKILLS` from `../tools/lib/hostile.mjs`, so the kit and the desk test the same list.
5. `desk-facts.mjs` here still names desk 0.1.1's ids and numbers; when the kit is rebuilt for a new desk, update them from `modules/shipped.json` and the manifests.
6. Rebuild the kit zip and put it in `modules/store/kit/` under the same name (or change `KIT_FILE` in `modules/store/server.js`), then run `node --test app/core/module-check modules/store`.

A check that differs between the desk and the kit is a bug: change it here, then copy.
