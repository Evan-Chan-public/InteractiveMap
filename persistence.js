// PERSISTENCE — autosave of the current map, plus cleanup of loaded data
//
// The map is saved to IndexedDB: the project record under 'project', the image Blob under 'image'
// (rewritten only when the image changes). Where IndexedDB is unavailable, annotations fall back to
// localStorage as before. Older versions saved annotations to localStorage: moved over on first load.

import { state } from './state.js';
import { generateId } from './utils.js';
import { imageRecord } from './image.js';
import { FORMAT, VERSION } from './project.js';

const LEGACY_KEYS = ['interactiveMap.annotations.v3', 'interactiveMap.annotations.v2', 'interactiveMap.annotations.v1'];
const DB_NAME     = 'interactiveMap';
const STORE       = 'kv';

// INDEXEDDB

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return dbPromise;
}

// one transaction: fn(store) queues requests; resolves with { key: value } for the gets it returns
async function transact(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx   = db.transaction(STORE, mode);
    const gets = fn(tx.objectStore(STORE)) || {};
    tx.oncomplete = () => resolve(Object.fromEntries(Object.entries(gets).map(([k, req]) => [k, req.result])));
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error || new Error('transaction aborted'));
  });
}

// status for the UI: 'saved' | 'error' (detail: message)
function report(status, message = '') {
  document.dispatchEvent(new CustomEvent('savestatus', { detail: { status, message } }));
}

// SAVE

let saveTimer  = null;
let imageDirty = false;

// image: the map image changed and must be written too
export function scheduleSave({ image = false } = {}) {
  if (image) imageDirty = true;
  if (!state.ui.autosave) return; // a map opened from a link isn't saved until it's kept
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

export async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!state.ui.autosave) return;
  const writeImage = imageDirty;
  imageDirty = false;
  const record = {
    format:      FORMAT,
    version:     VERSION,
    title:       state.title,
    modified:    new Date().toISOString(),
    image:       null,
    annotations: state.annotations,
  };
  const img = await imageRecord({ forFile: false });
  let blob = null;
  if (img) {
    ({ blob, ...record.image } = img);
    if (blob) record.image.stored = true; // the Blob lives under 'image'
  }
  try {
    await transact('readwrite', store => {
      store.put(record, 'project');
      if (writeImage) { if (blob) store.put(blob, 'image'); else store.delete('image'); }
    });
    report('saved');
  } catch (err) {
    if (writeImage) imageDirty = true; // try the image again next time
    if (!(await saveLegacy())) {
      console.warn('Could not save the map:', err);
      report('error', err?.name === 'QuotaExceededError' ? 'Storage is full' : (err?.message || 'unknown error'));
    }
  }
}

// annotations only, for browsers without IndexedDB
async function saveLegacy() {
  if (typeof indexedDB !== 'undefined') {
    try { await openDb(); return false; } catch { /* unavailable: fall through */ }
  }
  try {
    localStorage.setItem(LEGACY_KEYS[0], JSON.stringify(state.annotations));
    report('saved');
    return true;
  } catch {
    return false;
  }
}

// LOAD

// the saved map: { title, image, annotations } (unsanitized), or null if nothing is saved.
// image: { width, height, name, blob } | { width, height, src } | null
export async function loadSaved() {
  let legacy = null;
  try {
    const raw = LEGACY_KEYS.map(k => localStorage.getItem(k)).find(Boolean);
    if (raw) legacy = JSON.parse(raw);
  } catch (err) {
    console.warn('Could not read old saved annotations:', err);
  }
  // v1: region.points (single ring) → region.polygons (array of rings)
  if (Array.isArray(legacy?.regions)) {
    legacy.regions = legacy.regions.map(r => r?.points && !r.polygons ? { ...r, polygons: [r.points] } : r);
  }

  let project, image;
  try {
    ({ project, image } = await transact('readonly', store => ({ project: store.get('project'), image: store.get('image') })));
  } catch {
    // no IndexedDB: localStorage is the only store
    return legacy ? { title: '', image: null, annotations: legacy } : null;
  }

  // annotations left in localStorage by an older version are newer than anything in IndexedDB
  // (moving them removes them): move them over, keeping any saved title and image
  if (legacy) {
    project = { ...(project ?? { format: FORMAT, version: VERSION, title: '', image: null }),
                modified: new Date().toISOString(), annotations: legacy };
    try {
      await transact('readwrite', store => { store.put(project, 'project'); });
      LEGACY_KEYS.forEach(k => localStorage.removeItem(k));
    } catch (err) {
      console.warn('Could not move saved annotations to IndexedDB:', err);
    }
  }
  if (!project) return null;

  let img = project.image ?? null;
  if (img?.stored) img = image ? { ...img, blob: image } : null; // the Blob went missing: fall back to the baseline
  return { title: project.title, image: img, annotations: project.annotations };
}

export async function clearSaved() {
  clearTimeout(saveTimer);
  saveTimer = null;
  imageDirty = false;
  try { LEGACY_KEYS.forEach(k => localStorage.removeItem(k)); } catch {}
  try { await transact('readwrite', store => { store.delete('project'); store.delete('image'); }); } catch {}
}

// CLEANUP

// Ensures every region/pin has a layerId; creates a default layer if missing.
// Used for every load: saved maps, project files and share links.
export function ensureLayers(data) {
  if (!Array.isArray(data.layers) || data.layers.length === 0) {
    data.layers = [{ id: generateId(), name: 'Layer 1' }];
  }
  const fallback = data.layers[0].id;
  if (Array.isArray(data.regions)) {
    data.regions.forEach(r => { if (!r.layerId) r.layerId = fallback; });
  }
  if (Array.isArray(data.pins)) {
    data.pins.forEach(p => { if (!p.layerId) p.layerId = fallback; });
  }
  return data;
}

// Share links (and anything saved from one) are untrusted: rebuild every item from known fields
// with checked types, so ids and colours are safe to put in HTML attributes and the rest is plain data.
const SAFE_ID    = /^[\w-]{1,64}$/;
const HEX_COLOR  = /^#[0-9a-f]{3,8}$/i;
const num        = (n) => Number.isFinite(n);
const str        = (s, fallback = '') => typeof s === 'string' ? s : fallback;
const toPoint    = (p) => p && num(p.lat) && num(p.lng) ? { lat: p.lat, lng: p.lng } : null;

export function sanitizeAnnotations(data) {
  const ids  = new Map(); // unsafe id -> replacement, so parent links still resolve
  const id   = (v) => {
    if (typeof v === 'string' && SAFE_ID.test(v)) return v;
    if (!ids.has(v)) ids.set(v, generateId());
    return ids.get(v);
  };
  const ref  = (v) => (v == null ? null : id(v));
  const list = (v) => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [];

  const base = (it) => ({
    id:           id(it.id),
    layerId:      it.layerId == null ? undefined : id(it.layerId),
    label:        str(it.label),
    body:         str(it.body),
    hidden:       it.hidden === true,
    parentId:     ref(it.parentId),
    parentManual: it.parentManual === true,
  });
  // keep "no nesting yet" visible to ensureNesting for old data
  const nesting = (it, clean) => {
    if (!('parentId' in it)) { delete clean.parentId; delete clean.parentManual; }
    return clean;
  };

  return {
    layers: list(data?.layers).map(l => ({ id: id(l.id), name: str(l.name, 'Layer') })),
    regions: list(data?.regions).map(r => nesting(r, {
      ...base(r),
      color:    HEX_COLOR.test(r.color) ? r.color : '#4a9eff',
      polygons: (Array.isArray(r.polygons) ? r.polygons : [])
        .filter(Array.isArray)
        .map(ring => ring.map(toPoint).filter(Boolean))
        .filter(ring => ring.length >= 3),
    })).filter(r => r.polygons.length), // also drops empty leftovers from a failed brush stroke
    pins: list(data?.pins)
      .map(p => ({ p, latlng: toPoint(p.latlng) }))
      .filter(({ latlng }) => latlng)
      .map(({ p, latlng }) => nesting(p, { ...base(p), latlng })),
  };
}
