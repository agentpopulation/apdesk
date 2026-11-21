# The contracts

Every module works against these files. They are the only shared surface.
Change them only by changing this folder.

1. `MODULES.md`: how a module plugs in (manifest, server routes, UI panel, on/off, tools for the Coordinator).
2. `MODEL-DOOR.md`: the single door for every model call (router, Ollama, keyed providers, per-agent main and fallback, online/offline).
3. `APPROVAL-DOOR.md`: the single door for every approval (levels, auto-approve window, "send to a person" always asks, spend limits) and Panic.
4. `STORAGE.md`: one SQLite file and one workspace folder per space, backup and restore.
5. `PEOPLE.md`: the house (server, pairing, Panic, Offline, downloads, local engine, updates) and its spaces (one data folder and one full core each).

The code that implements them lives in `app/core/`. The contracts describe what the code does; where they differ, fix the code or the contract in the same commit.
