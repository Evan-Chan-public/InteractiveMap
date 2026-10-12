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

export function loadAnnotations() {
  try {
    // Try v3, then v2, then v1 with migration
    const raw = localStorage.getItem(STORAGE_KEY)
             || localStorage.getItem('interactiveMap.annotations.v2')
             || localStorage.getItem('interactiveMap.annotations.v1');
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (Array.isArray(data?.regions)) {
      state.annotations.regions = data.regions.map(r => {
        // v1: region.points (single ring) → region.polygons (array of rings)
        if (r.points && !r.polygons) {
          const { points, groupId, ...rest } = r;
          return { ...rest, polygons: [points] };
        }
        const { groupId, ...rest } = r;
        return rest;
      });
    }
    if (Array.isArray(data?.pins))   state.annotations.pins   = data.pins;
    if (Array.isArray(data?.layers)) state.annotations.layers = data.layers;
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
