// The Module Store's work on the modules folder: put a checked module in place, keep a replaced one asleep beside it,
// and take a removed one out (its files kept in the data folder). Nothing here runs a module's code.
import fs from 'node:fs';
import path from 'node:path';
import { listAll } from '../../app/core/module-check/files.mjs';
import { hashFolder } from '../../app/core/module-check/sig.mjs';
import { ADDED_FILE } from '../../app/core/modules.js';

const day = (d) => d.toISOString().slice(0, 10);

/** Where an old copy goes: <id>.old-<date>, then -2, -3 ... if that is taken. */
export function oldName(modulesDir, id, date = new Date()) {
  let name = `${id}.old-${day(date)}`; let n = 2;
  while (fs.existsSync(path.join(modulesDir, name))) name = `${id}.old-${day(date)}-${n++}`;
  return name;
}

/** The first file that differs from the hashes the check took, or null. */
export function changedSince(dir, hashes) {
  const now = new Map(hashFolder(dir, '').map((x) => [x.path, x.sha256])); const then = new Map((hashes || []).map((x) => [x.path, x.sha256]));
  return [...new Set([...now.keys(), ...then.keys()])].find((p) => now.get(p) !== then.get(p)) || null;
}

/**
 * Copy a checked module folder to modules/<id>, with the Store's record beside its files.
 * The files must be the very ones the check read (hashes). A module of that id already there is kept beside the new one
 * as <id>.old-<date>, with its module.json and test files renamed ".old", so the desk neither loads it nor runs its tests.
 * module.json is written last, so a look at the folder while it is copied never finds half a module.
 */
export function install(src, id, modulesDir, { hashes, record, date = new Date() }) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(id))) throw Object.assign(new Error('That module has no usable id.'), { status: 400 });
  const diff = changedSince(src, hashes);
  if (diff) throw Object.assign(new Error(`Not added: ${diff} changed after it was checked. Nothing was changed.`), { status: 409 });
  const target = path.join(modulesDir, id);
  let kept = null;
  if (fs.existsSync(target)) {
    kept = oldName(modulesDir, id, date);
    fs.renameSync(target, path.join(modulesDir, kept));
    for (const x of listAll(path.join(modulesDir, kept))) if (x.kind === 'file' && (x.rel === 'module.json' || /\.test\.m?js$/.test(x.rel))) fs.renameSync(x.abs, x.abs + '.old');
  }
  fs.mkdirSync(target);
  const files = listAll(src);
  for (const x of files) {
    const to = path.join(target, ...x.rel.split('/'));
    if (x.kind === 'dir') fs.mkdirSync(to, { recursive: true });
    else if (x.kind === 'file' && x.rel !== 'module.json') { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(x.abs, to, fs.constants.COPYFILE_EXCL); }
  }
  fs.writeFileSync(path.join(target, ADDED_FILE), JSON.stringify(record, null, 1));
  fs.copyFileSync(path.join(src, 'module.json'), path.join(target, 'module.json'), fs.constants.COPYFILE_EXCL);
  return { target, kept };
}

/** Take an added module's folder out of modules/ into keepDir/<id>-<date> (kept, never deleted). -> the kept folder's name */
export function takeOut(modulesDir, id, keepDir, date = new Date()) {
  const from = path.join(modulesDir, id);
  if (!fs.existsSync(path.join(from, ADDED_FILE)) && !fs.existsSync(path.join(from, 'module.json'))) throw Object.assign(new Error('That module is not here any more.'), { status: 404 });
  fs.mkdirSync(keepDir, { recursive: true });
  let name = `${id}-${day(date)}`; let n = 2;
  while (fs.existsSync(path.join(keepDir, name))) name = `${id}-${day(date)}-${n++}`;
  try { fs.renameSync(from, path.join(keepDir, name)); }
  catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(from, path.join(keepDir, name), { recursive: true, verbatimSymlinks: true }); fs.rmSync(from, { recursive: true, force: true }); }
  return name;
}
