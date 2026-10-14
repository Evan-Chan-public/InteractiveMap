import { state } from './state.js';
import { generateId } from './utils.js';

export const STORAGE_KEY = 'interactiveMap.annotations.v3';

// Mutable flags shared across modules via object reference
export const flags = { restoredAwaitingImage: false };

export function saveAnnotations() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.annotations));
  } catch (err) {
    console.warn('Could not save annotations:', err);
  }
}

let saveTimer = null;
export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAnnotations, 300);
}

// Ensures every region/pin has a layerId; creates a default layer if missing.
// Used by both localStorage and share-link loads.
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

export function loadAnnotations() {
  try {
    // Try v3, then v2, then v1 with migration
    const raw = localStorage.getItem(STORAGE_KEY)
             || localStorage.getItem('interactiveMap.annotations.v2')
             || localStorage.getItem('interactiveMap.annotations.v1');
    if (!raw) return false;
    const data = JSON.parse(raw);
    // v1: region.points (single ring) → region.polygons (array of rings)
    if (Array.isArray(data?.regions)) {
      data.regions = data.regions.map(r => r?.points && !r.polygons ? { ...r, polygons: [r.points] } : r);
    }
    Object.assign(state.annotations, sanitizeAnnotations(data));
    ensureLayers(state.annotations);
    return state.annotations.regions.length > 0 || state.annotations.pins.length > 0;
  } catch (err) {
    console.warn('Could not load annotations:', err);
    return false;
  }
}

export function clearSavedAnnotations() {
  state.annotations.regions = [];
  state.annotations.pins    = [];
  state.annotations.layers  = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('interactiveMap.annotations.v2');
    localStorage.removeItem('interactiveMap.annotations.v1');
  } catch {}
  flags.restoredAwaitingImage = false;
}
