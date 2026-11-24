// The one list of hostile sample modules and skills (fixtures/bad) and what the check must say about each.
// Used by this folder's own test, by the Module Store's "Add a module" test (modules/store), and by the kit's tests
// once the kit's copy is made from this folder: every place that checks a module refuses or marks each one the same way.
//   REFUSED  name -> a red line that must be in the report (the module is refused)
//   MARKED   name -> a yellow line that must be in the report (no red line: added only after the owner reads it)
//   RUN_ONLY name -> what the file reading cannot see; only the kit's locked-down run (--run) shows it. The desk never
//            runs a module to check it, so on the desk these come out with no red line, and the Store says so.

export const REFUSED = {
  'bad-child-process': /imports node:child_process/,
  'bad-eval': /eval or new Function runs text as code/,
  'bad-direct-fetch': /calls fetch directly/,
  'bad-undeclared-host': /outside host rates\.example\.net, which module\.json does not declare/,
  'bad-other-table': /"m_sales_leads", which belongs to another module/,
  'bad-core-table': /names the desk's "secrets" table/,
  'bad-path-climb': /readFileSync on a path that climbs out \(\.\.\/\.\.\/data\/apd\.sqlite\)/,
  'bad-packed': /long base64 string|looks packed/,
  'bad-tool-not-listed': /registers the tool "quiet_helper", which module\.json does not list/,
  'bad-ui-leak': /browser storage key "apd-session"/,
  'bad-computed-global': /holds globalThis in another name/,
  'bad-lexer': /eval or new Function runs text as code/,
  'bad-escaped-name': /a name written with escaped letters/,
  'bad-fs-join-climb': /readFileSync on a path that climbs out of the module's folder \(\.\.\/SECRET-key\.txt\)/,
  'bad-sqlite': /imports node:sqlite, which opens a database of its own/,
  'bad-timers-import': /imports node:timers/,
  'bad-detects-check': /process\.getBuiltinModule reaches the inside of Node/,
  'bad-builtins': /holds Array\.prototype in a name|sets JSON\.parse/,
  'bad-ui-image': /sets \.src to an address built at run time/,
  'bad-fs-dollar': /node:fs r\$ on a path that climbs out/,
  'bad-fetch-undeclared': /calls ctx\.fetch but declares no hosts/,
  'bad-constructor': /reaches a constructor through \.constructor/,
  'bad-tool-computed': /registers a tool whose name the checker could not read/,
  'bad-proto-alias': /holds Array\.prototype in a name/,
  // the same powers by other spellings: optional chaining, names that hold them, destructures, spreads, arguments,
  // members of the global object, template imports and a second file that hands node:fs on
  'bad-optional-chain': /process\.getBuiltinModule reaches the inside of Node/,
  'bad-function-optional': /eval or new Function runs text as code/,
  'bad-keys-held': /reaches the owner's model keys/,
  'bad-process-passed': /uses process in a way the checker cannot follow/,
  'bad-process-spread': /uses process in a way the checker cannot follow/,
  'bad-global-member': /uses globalThis\.process in a way the checker cannot follow/,
  'bad-function-in-list': /uses Function in a way the checker cannot follow/,
  'bad-fs-member-held': /holds node:fs writeFileSync in a name/,
  'bad-fs-promises-named': /node:fs writeFile on an absolute path/,
  'bad-keys-nested': /reaches the owner's model keys/,
  'bad-keys-optional': /reaches the owner's model keys/,
  'bad-reflect-global': /uses globalThis in a way the checker cannot follow/,
  'bad-fetch-held': /holds fetch in a name or passes it on/,
  'bad-template-import': /imports node:child_process\./,
  'bad-fs-reexport': /hands node:fs on to another file/,
  // the rule behind them: a module may not import the risky built-ins at all, by any name or path, and what the reader
  // cannot follow is red by itself (the module has the desk's doors on ctx instead)
  'bad-import-star': /imports node:child_process\. A module may not start programs/,
  'bad-import-renamed': /imports child_process\. A module may not start programs/,
  'bad-import-computed': /a dynamic import of a computed path/,
  'bad-import-resolved': /a dynamic import of a computed path/,
  'bad-create-require': /imports node:module, which can load code around the module's imports/,
  'bad-reexport-member': /helper\.js line 1: imports node:child_process/,
  'bad-process-destructured': /holds process in another name/,
  'bad-process-computed': /reaches into process with a name built at run time/,
  'bad-reflect-get': /uses process in a way the checker cannot follow/,
  'bad-global-destructured': /holds globalThis in another name/,
  'bad-eval-indirect': /eval or new Function runs text as code/,
  'bad-keys-member-destructured': /reaches the owner's model keys/,
  'bad-keys-computed': /reaches the owner's model keys/,
  'bad-ctor-joined': /reaches the member "constructor" by a name in brackets/,
  'bad-ctor-list-join': /reaches the member "constructor" by a name in brackets/,
  'bad-ctor-plain-key': /reaches the member "constructor" by a name in brackets/,
  'bad-ctor-inline': /reaches the member "constructor" by a name in brackets/,
  'run-env': /process\.getBuiltinModule reaches the inside of Node/,
  'run-powers': /process\.getBuiltinModule reaches the inside of Node/,
};

export const MARKED = {
  'bad-timer': /Starts 1 repeating timer and clears 0/,
  'bad-sql-built': /a table name built at run time\): SQL the checker cannot read\. The desk itself does not stop/,
};

export const RUN_ONLY = {
  'run-timer-chain': 'a setTimeout chain that keeps running after it is switched off; only the locked-down run sees it',
};

/** Hostile skills (fixtures/bad/skills): name -> a red line the skill check must give. */
export const SKILLS = {
  'k01-tagchars': /Line 9 holds invisible characters \(U\+E0020, the invisible "tag" letters/,
  'k02-split': /Line 12 acts without asking the owner|Lines 9 to 12, read together, acts without asking/,
  'k04-note': /Line 10 speaks to the agent as if it were the owner or the system/,
  'k05-codeblock': /Line 11 speaks to the agent as if it were the owner or the system/,
  'k06-header': /Line 3 reveals keys, logins or files/,
  'k07-bundled': /Line 9 tells the agent to follow notes\/extra\.txt|notes\/extra\.txt line 1/,
  'k08-synonyms': /Line 9 acts without asking the owner/,
  'k09-softhyphen': /Line 9 tells the agent to ignore earlier instructions/,
  'k10-mdref': /Line 10 is a markdown comment/,
};
