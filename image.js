// IMAGE — the map image: upload, paste, baseline file, and the placeholder shown without one

import { state } from './state.js';
import { clearSavedAnnotations, ensureLayers, flags } from './persistence.js';
import { map } from './map.js';
import { mountAll } from './render.js';
import { renderDetailPanel } from './panel.js';
import { renderLayerStrip } from './layerstrip.js';

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

  if (flags.restoredAwaitingImage) {
    const r = state.annotations.regions.length;
    const p = state.annotations.pins.length;
    const parts = [];
    if (r) parts.push(`${r} region${r === 1 ? '' : 's'}`);
    if (p) parts.push(`${p} pin${p === 1 ? '' : 's'}`);
    ph.innerHTML = `
      <div class="placeholder-restore">
        <p>${parts.join(' and ')} restored from your previous session.<br/>
           Upload the original image to continue.</p>
        <button id="discard-saved" class="btn-link">Discard saved annotations</button>
      </div>
    `;
    document.getElementById('discard-saved')?.addEventListener('click', () => {
      clearSavedAnnotations();
      ensureLayers(state.annotations);
      state.ui.activeLayerId = state.annotations.layers[0].id;
      renderLayerStrip();
      updatePlaceholder();
    });
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
});

document.addEventListener('paste', (e) => {
  if (state.mode !== 'design') return;
  const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (item) loadImageFile(item.getAsFile());
});

function loadImageFile(file) {
  loadImageUrl(URL.createObjectURL(file));
}

// baseline map, loaded at startup unless an image is already up. ?map=other.png picks another file
export const BASEMAP_URL = new URLSearchParams(location.search).get('map') || 'basemap.png';

// ifEmpty: a slow baseline must not replace an image uploaded while it was loading
export function loadImageUrl(url, { ifEmpty = false } = {}) {
  const img = new Image();
  img.onload = () => {
    if (ifEmpty && state.image) return;
    applyImage(img, url);
  };
  img.onerror = () => { if (!ifEmpty) console.warn('Could not load map image:', url); };
  img.src = url;
}

function applyImage(img, url) {
  const width  = img.naturalWidth;
  const height = img.naturalHeight;
  if (imageOverlay) imageOverlay.remove();
  mapBounds    = [[0, 0], [-height, width]];
  imageOverlay = L.imageOverlay(url, mapBounds).addTo(map);
  map.fitBounds(mapBounds);
  state.image  = { url, width, height, el: img };
  mapPlaceholder.classList.add('hidden');

  if (flags.restoredAwaitingImage) {
    mountAll();
    flags.restoredAwaitingImage = false;
  }
  renderDetailPanel();
}
