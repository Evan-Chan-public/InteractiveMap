// IMAGE — the map image: upload, paste, baseline file, project images, and the placeholder shown without one

import { state } from './state.js';
import { scheduleSave } from './persistence.js';
import { map } from './map.js';
import { applyInteractivity, applyZOrder } from './render.js';
import { renderDetailPanel } from './panel.js';
import { discardSaved } from './project.js';

// DOM

const mapPlaceholder   = document.getElementById('map-placeholder');
const btnUpload        = document.getElementById('tool-upload');
const uploadInput      = document.getElementById('upload-input');

let imageOverlay = null;
let mapBounds    = null;

// PLACEHOLDER

export function updatePlaceholder() {
  const ph = mapPlaceholder;
  if (!ph) return;
  if (state.image) { ph.classList.add('hidden'); return; }
  ph.classList.remove('hidden');

  const r = state.annotations.regions.length;
  const p = state.annotations.pins.length;
  if (r || p) {
    const parts = [];
    if (r) parts.push(`${r} region${r === 1 ? '' : 's'}`);
    if (p) parts.push(`${p} pin${p === 1 ? '' : 's'}`);
    ph.innerHTML = `
      <div class="placeholder-restore">
        <p>${parts.join(' and ')} loaded, but the map image is missing.<br/>
           Upload the original image to continue.</p>
        ${state.ui.autosave ? '<button id="discard-saved" class="btn-link">Discard saved map</button>' : ''}
      </div>
    `;
    document.getElementById('discard-saved')?.addEventListener('click', discardSaved);
  } else if (state.ui.shareLocked) {
    ph.innerHTML = '<p>No map image provided with this share link.</p>';
  } else {
    ph.innerHTML = '<p>No map loaded.<br/>Switch to Design Mode and upload an image.</p>';
  }
}

// IMG UPLOAD

btnUpload.addEventListener('click', () => uploadInput.click());

uploadInput.addEventListener('change', () => {
  const file = uploadInput.files[0];
  if (file) loadImageFile(file);
  uploadInput.value = ''; // picking the same file again still fires change
});

document.addEventListener('paste', (e) => {
  if (state.mode !== 'design') return;
  const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (item) loadImageFile(item.getAsFile());
});

// an uploaded, pasted or dropped image becomes part of the project
export async function loadImageFile(file) {
  if (await showImage({ kind: 'blob', blob: file, name: file.name })) scheduleSave({ image: true });
}

// baseline map, used when the project has no image of its own: ?map=file if given, else a local
// basemap.png (gitignored: your own map), else the bundled world map
const MAP_PARAM    = new URLSearchParams(location.search).get('map');
const BASEMAP_URLS = MAP_PARAM ? [MAP_PARAM] : ['basemap.png', 'maps/world.png'];

export const mapParam = MAP_PARAM;

export async function loadBaseline(urls = BASEMAP_URLS) {
  for (const src of urls) {
    if (await showImage({ kind: 'baseline', src }, { quiet: true })) return true;
  }
  clearImage(); // nothing found: the placeholder takes over
  return false;
}

// source: { kind: 'blob', blob, name } | { kind: 'baseline' | 'ref', src }. resolves false if it can't load
export function showImage(source, { quiet = false } = {}) {
  const url = source.kind === 'blob' ? URL.createObjectURL(source.blob) : source.src;
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      applyImage(img, url, source);
      resolve(true);
    };
    img.onerror = () => {
      if (source.kind === 'blob') URL.revokeObjectURL(url);
      if (!quiet) console.warn('Could not load map image:', source.name || url);
      resolve(false);
    };
    img.src = url;
  });
}

function applyImage(img, url, source) {
  const width  = img.naturalWidth;
  const height = img.naturalHeight;
  const old    = state.image;
  if (imageOverlay) imageOverlay.remove();
  mapBounds    = [[0, 0], [-height, width]];
  imageOverlay = L.imageOverlay(url, mapBounds).addTo(map);
  map.fitBounds(mapBounds);
  if (old?.source.kind === 'blob' && old.url !== url) URL.revokeObjectURL(old.url);
  state.image  = { url, width, height, el: img, source };
  mapPlaceholder.classList.add('hidden');
  // annotations mounted before the map had a view get their elements now: restack and restyle them
  applyZOrder();
  applyInteractivity();
  renderDetailPanel();
}

export function clearImage() {
  if (imageOverlay) imageOverlay.remove();
  imageOverlay = null;
  if (state.image?.source.kind === 'blob') URL.revokeObjectURL(state.image.url);
  state.image = null;
  updatePlaceholder();
  renderDetailPanel();
}

// SAVED FORM

// bundled maps ship with the app, so projects refer to them by path instead of embedding them
const isBundled = (src) => /^maps\/[\w.-]+$/.test(src);

// the image as a project stores it. forFile: embedded as a data URL (a JSON file can't hold a Blob);
// otherwise as the Blob itself (IndexedDB stores it directly). Baselines aren't saved with the project
// unless it's going into a file, where the recipient may not have the same baseline.
export async function imageRecord({ forFile }) {
  const img = state.image;
  if (!img) return null;
  const { width, height, source } = img;
  if (source.kind === 'baseline' && !forFile) return null;
  if (source.kind !== 'blob' && isBundled(source.src)) return { width, height, src: source.src };

  let blob = source.blob;
  const name = source.name || (source.src || '').split(/[/?#]/).filter(Boolean).pop() || 'map';
  if (!blob) {
    try {
      const res = await fetch(source.src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      blob = await res.blob();
    } catch (err) {
      console.warn('Could not read the map image to embed it; saving a reference instead:', err);
      return { width, height, src: source.src };
    }
  }
  if (!forFile) return { width, height, name, blob };
  return { width, height, name, data: await blobToDataUrl(blob) };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
