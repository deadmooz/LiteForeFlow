/*
 * Plugins: extra nodes and credential types that live in their own folder, so adding an integration never means
 * editing LiteForeFlow itself.
 *
 *   plugins/<id>/            shipped with LiteForeFlow ("bundled")
 *   data/plugins/<id>/       yours: drop a folder in, restart (or press Reload on the Plugins page)
 *
 * A plugin folder holds `plugin.json` ({ id, name, version, description, author }) and an entry file (index.js by
 * default) that exports  register(sdk).  See docs/PLUGINS.md and plugins/_template.
 *
 * Plugins run inside the server with the same rights as LiteForeFlow, so only install plugins you trust.
 * One broken plugin never stops the app: its error is shown on the Plugins page and everything else keeps working.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from './config.js';
import { defineNode, hasNodeType, removePluginNodes, listNodeTypes } from './nodes/registry.js';
import { credentialProperty } from './nodes/registry.js';
import { addCredentialType, removePluginCredentialTypes, getCredentialType } from './credentialTypes.js';
import { httpRequest } from './http.js';
import { loadCredential } from './credentials.js';
import { checkConditions } from './nodes/core.js';

export const API_VERSION = 1;
const BUNDLED_DIR = fileURLToPath(new URL('../../plugins', import.meta.url));
const USER_DIR = path.join(config.dataDir, 'plugins');
const STATE_FILE = path.join(config.dataDir, 'plugins.json');
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const NODE_TYPE = /^[a-z][a-z0-9]*(\.[A-Za-z0-9_-]+)+$/;

/** id -> { manifest, dir, source, status, error, nodes, credentialTypes } */
const plugins = new Map();

function readState() {
  try { return { disabled: [], knownNodes: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { return { disabled: [], knownNodes: {} }; }
}
function writeState(state) {
  const text = JSON.stringify(state, null, 2);
  try {
    // Several processes (API + workers) share this file: never touch it when nothing changed.
    if (fs.existsSync(STATE_FILE) && fs.readFileSync(STATE_FILE, 'utf8') === text) return;
    fs.writeFileSync(STATE_FILE, text);
  } catch { /* read-only data folder: the choice lasts until restart */ }
}

function findPluginFolders() {
  const out = [];
  const dirs = [[BUNDLED_DIR, 'bundled'], [USER_DIR, 'user'], ...(config.pluginsDir ? [[config.pluginsDir, 'user']] : [])];
  for (const [dir, source] of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')).map((e) => e.name); } catch { /* folder does not exist yet */ }
    for (const name of names.sort()) out.push({ dir: path.join(dir, name), source, folder: name });
  }
  return out;
}

function readManifest(dir) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch (e) {
    throw new Error(e.code === 'ENOENT' ? 'plugin.json is missing' : `plugin.json is not valid JSON (${e.message})`);
  }
  if (!ID.test(raw.id ?? '')) throw new Error('plugin.json "id" must be 2-40 characters: lowercase letters, numbers and dashes');
  if (!raw.name) throw new Error('plugin.json needs a "name"');
  if ((raw.apiVersion ?? API_VERSION) > API_VERSION) throw new Error(`This plugin needs a newer LiteForeFlow (plugin API ${raw.apiVersion})`);
  return { entry: 'index.js', version: '0.0.0', description: '', author: '', ...raw };
}

/** What a plugin's register(sdk) receives. Everything it adds is tagged so it can be removed again. */
function makeSdk(manifest, dir, added) {
  const dataDir = path.join(config.dataDir, 'plugin-data', manifest.id);
  return {
    apiVersion: API_VERSION,
    pluginId: manifest.id,
    pluginDir: dir,
    /** A private folder for the plugin's own files (created on first use). */
    dataDir: () => { fs.mkdirSync(dataDir, { recursive: true }); return dataDir; },
    defineNode(def) {
      if (!def?.type || !NODE_TYPE.test(def.type)) throw new Error(`Node type "${def?.type}" must look like "myplugin.hello" (letters and numbers, with a dot)`);
      if (hasNodeType(def.type)) throw new Error(`Node type "${def.type}" already exists (pick a different name)`);
      if (!def.name) throw new Error(`Node "${def.type}" needs a name`);
      if (!def.execute && !def.executeItem && !(def.prepareItem && def.runPrepared)) throw new Error(`Node "${def.type}" needs an executeItem() or execute() function`);
      defineNode({ group: 'app', icon: '🧩', description: '', ...def, plugin: manifest.id });
      added.nodes.push(def.type);
    },
    defineCredentialType(def) {
      if (!def?.id || !def.name || !Array.isArray(def.fields)) throw new Error('A credential type needs id, name and fields');
      addCredentialType({ ...def, plugin: manifest.id });
      added.credentialTypes.push(def.id);
    },
    credentialProperty,
    /** The same condition check the IF node uses: (conditions, 'all' | 'any', ctx.sandbox) -> true / false. */
    checkConditions,
    httpRequest,
    loadCredential,
    publicUrl: () => config.publicUrl,
    readJson: (rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')),
    listFiles: (rel, ext) => { try { return fs.readdirSync(path.join(dir, rel)).filter((f) => !ext || f.endsWith(ext)).map((f) => path.join(dir, rel, f)); } catch { return []; } },
    log: (...a) => console.log(`[plugin ${manifest.id}]`, ...a),
  };
}

function unload(id) {
  removePluginNodes(id);
  removePluginCredentialTypes(id);
}

async function loadOne({ dir, source, folder }, state) {
  let manifest;
  try { manifest = readManifest(dir); } catch (e) {
    const id = `broken:${source}:${folder}`;
    plugins.set(id, { manifest: { id: folder, name: folder, version: '', description: '' }, dir, source, status: 'error', error: e.message, nodes: [], credentialTypes: [] });
    return;
  }
  if (plugins.has(manifest.id)) {
    plugins.set(`dup:${source}:${folder}`, { manifest, dir, source, status: 'error', error: `Another plugin already uses the id "${manifest.id}"`, nodes: [], credentialTypes: [] });
    return;
  }
  const entry = { manifest, dir, source, status: 'ok', error: '', nodes: [], credentialTypes: [] };
  plugins.set(manifest.id, entry);
  if (state.disabled.includes(manifest.id)) {
    entry.status = 'disabled';
    entry.nodes = (state.knownNodes[manifest.id] ?? []).map((type) => ({ type, name: type }));
    return;
  }
  const added = { nodes: [], credentialTypes: [] };
  try {
    const file = path.resolve(dir, manifest.entry);
    const rel = path.relative(dir, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('The entry file must be inside the plugin folder');
    if (!fs.existsSync(file)) throw new Error(`Entry file "${manifest.entry}" is missing`);
    const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
    const register = mod.register ?? mod.default;
    if (typeof register !== 'function') throw new Error(`"${manifest.entry}" must export a register(sdk) function`);
    await register(makeSdk(manifest, dir, added));
    entry.nodes = added.nodes.map((type) => ({ type, name: listNodeTypes().find((n) => n.type === type)?.name ?? type }));
    entry.credentialTypes = added.credentialTypes.map((id) => ({ id, name: getCredentialType(id)?.name ?? id }));
    state.knownNodes[manifest.id] = added.nodes;
  } catch (e) {
    unload(manifest.id);
    entry.status = 'error';
    entry.error = String(e.message ?? e).split('\n')[0];
    entry.nodes = [];
    entry.credentialTypes = [];
    console.warn(`[plugins] "${manifest.id}" could not be loaded: ${entry.error}`);
  }
}

// Loading, reloading and switching run one at a time, so two quick clicks can never leave a plugin half registered.
let queue = Promise.resolve();
const exclusive = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

/** Finds and loads every plugin. Safe to call again (it reloads everything). */
export const loadPlugins = () => exclusive(loadPluginsNow);

async function loadPluginsNow() {
  for (const id of [...plugins.keys()]) unload(id);
  plugins.clear();
  const state = readState();
  for (const folder of findPluginFolders()) await loadOne(folder, state);
  writeState(state);
  const ok = [...plugins.values()].filter((p) => p.status === 'ok').length;
  if (plugins.size) console.log(`[plugins] ${ok} of ${plugins.size} loaded`);
  return listPlugins();
}

/**
 * Keeps several processes in step. In the Docker edition the API and each worker are separate processes sharing one data
 * folder: when a plugin is switched on/off on the Plugins page, or a plugin folder is added or edited, every process
 * notices within a few seconds and reloads. (The fingerprint ignores `knownNodes`, so a reload never wakes the others up.)
 */
function fingerprint() {
  const parts = [JSON.stringify([...readState().disabled].sort())];
  for (const f of findPluginFolders()) {
    let stamp = 'x';
    try {
      const entry = readManifest(f.dir).entry;
      stamp = `${fs.statSync(path.join(f.dir, 'plugin.json')).mtimeMs}:${fs.statSync(path.join(f.dir, entry)).mtimeMs}`;
    } catch { /* a broken folder still counts as "present" */ }
    parts.push(`${f.dir}@${stamp}`);
  }
  return parts.join('|');
}

export function watchPlugins(intervalMs = 3000) {
  let last = fingerprint();
  const timer = setInterval(async () => {
    const now = fingerprint();
    if (now === last) return;
    console.log('[plugins] a change was detected, reloading');
    try { await loadPlugins(); } catch (e) { console.warn(`[plugins] reload failed: ${e.message}`); }
    last = fingerprint();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function listPlugins() {
  return [...plugins.values()].map((p) => ({
    id: p.manifest.id, name: p.manifest.name, version: p.manifest.version, description: p.manifest.description,
    author: p.manifest.author, homepage: p.manifest.homepage, source: p.source, status: p.status, error: p.error,
    nodes: p.nodes, credentialTypes: p.credentialTypes,
  })).sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'user' ? -1 : 1));
}

export const setPluginEnabled = (id, enabled) => exclusive(() => setEnabledNow(id, enabled));

async function setEnabledNow(id, enabled) {
  const entry = plugins.get(id);
  if (!entry) throw Object.assign(new Error('Plugin not found'), { status: 404 });
  const state = readState();
  state.disabled = state.disabled.filter((x) => x !== id);
  if (!enabled) state.disabled.push(id);
  writeState(state);
  if (!enabled) {
    if (entry.nodes.length) state.knownNodes[id] = entry.nodes.map((n) => n.type); // never forget which blocks it had
    writeState(state);
    unload(id);
    entry.status = 'disabled';
    entry.error = '';
    return listPlugins();
  }
  unload(id); // switching on a plugin that is already on must not register its blocks a second time
  plugins.delete(id);
  await loadOne({ dir: entry.dir, source: entry.source, folder: path.basename(entry.dir) }, state);
  writeState(state);
  return listPlugins();
}

/** For validation messages: "this node comes from the plugin X, which is switched off / broken". */
export function pluginForMissingType(type) {
  const state = readState();
  for (const [pid, types] of Object.entries(state.knownNodes)) {
    if (types.includes(type)) {
      const p = plugins.get(pid);
      return { id: pid, name: p?.manifest.name ?? pid, status: p?.status ?? 'missing' };
    }
  }
  return null;
}
