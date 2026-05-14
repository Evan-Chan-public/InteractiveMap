import { state } from './state.js';

// PERSISTENCE

export const STORAGE_KEY = 'interactiveMap.annotations.v2';

// object reference lets other modules read/write restoredAwaitingImage as a live value
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

export function loadAnnotations() {
  try {
    // Try v2 first, then fall back to v1 with migration
    const raw = localStorage.getItem(STORAGE_KEY)
             || localStorage.getItem('interactiveMap.annotations.v1');
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (Array.isArray(data?.regions)) {
      state.annotations.regions = data.regions.map(r => {
        // Migrate v1: region.points (single ring) → region.polygons (array of rings)
        if (r.points && !r.polygons) {
          const { points, groupId, ...rest } = r;
          return { ...rest, polygons: [points] };
        }
        // Strip any leftover groupId from pre-refactor saves
        const { groupId, ...rest } = r;
        return rest;
      });
    }
    if (Array.isArray(data?.pins)) state.annotations.pins = data.pins;
    return state.annotations.regions.length > 0 || state.annotations.pins.length > 0;
  } catch (err) {
    console.warn('Could not load annotations:', err);
    return false;
  }
}

export function clearSavedAnnotations() {
  state.annotations.regions = [];
  state.annotations.pins    = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('interactiveMap.annotations.v1');
  } catch {}
  flags.restoredAwaitingImage = false;
}
