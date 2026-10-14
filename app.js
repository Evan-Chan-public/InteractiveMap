import { state, layers, historyStack, redoStack, navStack, HISTORY_MAX } from './state.js';
import { generateId, escapeHtml, pointInRing,
         circlePoly, latlngDist, ringToGeom, MERGE_BUFFER_PX, inflatePolygon } from './utils.js';
import { flags, scheduleSave, loadAnnotations, clearSavedAnnotations, ensureLayers,
         sanitizeAnnotations } from './persistence.js';
import { encodeShare, decodeShare } from './share.js';
import { childrenOf, ancestorsOf, autoParent, wouldCycle, findItem, renest, renestAround,
         orphanChildrenOf, renestAll, ensureNesting } from './nesting.js';

// WASM WORKER

const WINDOW = 1024;

let worker      = null;
let workerReady = false;
let wandPending = false;
let wandOffset  = { x: 0, y: 0 };
let wandStage   = '';
let wandStart   = 0;
let wandTicker  = null;

function initWorker() {
  worker = new Worker('./worker.js');
  worker.onmessage = (e) => {
    const msg = e.data;
    if      (msg.type === 'ready')    { workerReady = true; }
    else if (msg.type === 'progress') { wandStage = msg.stage; updateWandTicker(msg); }
    else if (msg.type === 'result')   { stopWandTicker(); onWandResult(msg); }
    else if (msg.type === 'empty')    {
      stopWandTicker(); wandPending = false;
      setWandStatus('No fill — try adjusting tolerance or clicking a different spot.');
    }
    else if (msg.type === 'error')    {
      stopWandTicker(); wandPending = false;
      setWandStatus('Error: ' + msg.reason);
    }
  };
}

function startWandTicker() {
  wandStart  = performance.now();
  wandStage  = 'queued';
  if (wandTicker) clearInterval(wandTicker);
  wandTicker = setInterval(() => updateWandTicker(), 100);
  updateWandTicker();
  btnWandCancel?.classList.remove('hidden');
}

function stopWandTicker() {
  if (wandTicker) { clearInterval(wandTicker); wandTicker = null; }
  btnWandCancel?.classList.add('hidden');
}

const STAGE_LABEL = {
  queued:   'Queued',
  fill:     'Filling',
  trace:    'Tracing boundary',
  simplify: 'Simplifying',
};

function updateWandTicker(msg) {
  const elapsed = ((performance.now() - wandStart) / 1000).toFixed(1);
  const label   = STAGE_LABEL[wandStage] ?? wandStage;
  let extra = '';
  if (msg?.filled   != null) extra += ` · ${msg.filled.toLocaleString()} px`;
  if (msg?.rawCount != null) extra += ` · ${msg.rawCount.toLocaleString()} corners`;
  setWandStatus(`${label}… ${elapsed}s${extra}`);
}

function cancelWand() {
  if (!wandPending) return;
  worker.terminate();
  worker      = null;
  workerReady = false;
  wandPending = false;
  stopWandTicker();
  setWandStatus('Cancelled.');
  initWorker();
}

let sourceImage = null;

// MAP SETUP

const map = L.map('map', {
  crs: L.CRS.Simple,
  minZoom: -4,
  maxZoom: 4,
  zoomSnap: 0,
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 40,
  zoomAnimation: false,
  attributionControl: false,
});

let imageOverlay = null;
let mapBounds    = null;

// BRUSH STATE

let brushSizePx      = 30;
const vertexEdit     = { active: false, regionId: null, handles: [], midHandles: [] };
let brushCursorLayer = null;
let brushPainting    = false;
let brushLastLatLng  = null;

// DOM

const toolsPanel       = document.getElementById('tools-panel');
const detailPanel      = document.getElementById('detail-panel');
const detailHeader     = detailPanel.querySelector('.panel-header');
const detailContent    = document.getElementById('detail-content');
const detailTree       = document.getElementById('detail-tree');
const mapPlaceholder   = document.getElementById('map-placeholder');
const btnMode          = document.getElementById('btn-mode');
const btnShare         = document.getElementById('btn-share');
const shareDialog      = document.getElementById('share-dialog');
const shareLock        = document.getElementById('share-lock');
const shareUrl         = document.getElementById('share-url');
const shareCopy        = document.getElementById('share-copy');
const shareNote        = document.getElementById('share-note');
const layerChips       = document.getElementById('layer-chips');
const btnLayerAdd      = document.getElementById('layer-add');
const btnUpload        = document.getElementById('tool-upload');
const uploadInput      = document.getElementById('upload-input');
const btnRegion        = document.getElementById('tool-region');
const btnPin           = document.getElementById('tool-pin');
const btnWand          = document.getElementById('tool-wand');
const wandStatus       = document.getElementById('wand-status');
const wandTolerance    = document.getElementById('wand-tolerance');
const wandToleranceVal = document.getElementById('wand-tolerance-val');
const btnWandCancel    = document.getElementById('wand-cancel');
const btnBrush         = document.getElementById('tool-brush');
const btnEraser        = document.getElementById('tool-eraser');
const btnEdit          = document.getElementById('tool-edit');
const wandOptions      = document.getElementById('wand-options');
const brushControls    = document.getElementById('brush-controls');
const brushSizeInput   = document.getElementById('brush-size');
const brushSizeVal     = document.getElementById('brush-size-val');

wandTolerance?.addEventListener('input', () => {
  if (wandToleranceVal) wandToleranceVal.textContent = wandTolerance.value;
});
btnWandCancel?.addEventListener('click', cancelWand);

brushSizeInput?.addEventListener('input', () => {
  brushSizePx = parseInt(brushSizeInput.value, 10);
  if (brushSizeVal) brushSizeVal.textContent = brushSizePx;
});

// PLACEHOLDER

function updatePlaceholder() {
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
  } else if (shareLocked) {
    ph.innerHTML = '<p>No map image provided with this share link.</p>';
  } else {
    ph.innerHTML = '<p>No map loaded.<br/>Switch to Design Mode and upload an image.</p>';
  }
}

// SHARE

let shareLocked = false; // set on load when URL hash contains a locked share

// long links still work in the address bar, but chat apps and some sites cut them off
const LONG_LINK_CHARS = 8000;

async function refreshShareUrl() {
  shareUrl.value = 'Building link…';
  const hash = await encodeShare(state.annotations, shareLock.checked);
  shareUrl.value = `${location.origin}${location.pathname}${location.search}#${hash}`;
  const kb = (shareUrl.value.length / 1024).toFixed(1);
  shareNote.textContent = (shareUrl.value.length > LONG_LINK_CHARS
    ? `Long link (${kb} KB): some apps may cut it off. ` : `Link size ${kb} KB. `)
    + 'The map image is not included: viewers get the baseline map if the site serves one, otherwise they upload it.';
}

async function loadShareHash(hash) {
  const payload = await decodeShare(hash);
  if (!payload) return false;
  Object.assign(state.annotations, sanitizeAnnotations(payload.annotations));
  ensureLayers(state.annotations);
  shareLocked = !!payload.lock;
  return true;
}

btnShare.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = !shareDialog.classList.contains('hidden');
  shareDialog.classList.toggle('hidden', isOpen);
  if (!isOpen) refreshShareUrl();
});

shareLock.addEventListener('change', refreshShareUrl);

shareCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(shareUrl.value).then(() => {
    shareCopy.textContent = 'Copied!';
    setTimeout(() => { shareCopy.textContent = 'Copy'; }, 1500);
  });
});

document.addEventListener('click', (e) => {
  if (!shareDialog.classList.contains('hidden') && !shareDialog.contains(e.target) && e.target !== btnShare) {
    shareDialog.classList.add('hidden');
  }
});

// LAYERS

function renderLayerStrip() {
  layerChips.innerHTML = '';
  const editable = state.mode === 'design';
  const onlyOne  = state.annotations.layers.length === 1;
  btnLayerAdd.classList.toggle('hidden', !editable);

  state.annotations.layers.forEach(layer => {
    const chip = document.createElement('div');
    chip.className = 'layer-chip' + (layer.id === state.ui.activeLayerId ? ' active' : '');
    chip.dataset.id = layer.id;
    chip.draggable  = editable;

    const name = document.createElement('span');
    name.className = 'layer-chip-name';
    name.textContent = layer.name;
    chip.appendChild(name);

    if (editable && !onlyOne) {
      const close = document.createElement('span');
      close.className = 'layer-chip-close';
      close.textContent = '×';
      close.title = 'Delete layer';
      chip.appendChild(close);
    }

    chip.addEventListener('click', (e) => {
      if (e.target === name && name.isContentEditable) return;
      if (e.target.classList.contains('layer-chip-close')) {
        handleLayerDelete(layer.id, e.target);
        return;
      }
      setActiveLayer(layer.id);
    });

    if (editable) {
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRenameLayer(layer.id, name);
      });
    }

    chip.addEventListener('dragstart', (e) => {
      if (name.isContentEditable) { e.preventDefault(); return; }
      chip.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', layer.id);
    });
    chip.addEventListener('dragend', () => {
      chip.classList.remove('dragging');
      layerChips.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    chip.addEventListener('dragover', (e) => {
      e.preventDefault();
      chip.classList.add('drag-over');
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('drag-over'));
    chip.addEventListener('drop', (e) => {
      e.preventDefault();
      chip.classList.remove('drag-over');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (draggedId && draggedId !== layer.id) reorderLayer(draggedId, layer.id);
    });

    layerChips.appendChild(chip);
  });
}

function reorderLayer(draggedId, targetId) {
  const arr = state.annotations.layers;
  const from = arr.findIndex(l => l.id === draggedId);
  const to   = arr.findIndex(l => l.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  pushHistory();
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);
  renderLayerStrip();
  applyZOrder();
  scheduleSave();
}

function applyZOrder() {
  // iterate bottom→top; bringToFront stacks each above the previous
  for (const layer of state.annotations.layers) {
    for (const region of state.annotations.regions) {
      if (region.layerId === layer.id) layers.regions[region.id]?.bringToFront();
    }
  }
}

// regions on higher layers must stay stacked above a freshly mounted one
function restackAbove(region) {
  const order = state.annotations.layers.map(l => l.id);
  for (const layerId of order.slice(order.indexOf(region.layerId) + 1)) {
    for (const r of state.annotations.regions) {
      if (r.layerId === layerId) layers.regions[r.id]?.bringToFront();
    }
  }
}

function findAnnotation(type, id) {
  const list = type === 'region' ? state.annotations.regions : state.annotations.pins;
  return list.find(a => a.id === id);
}

// layer chip: design keeps a selection that's on the layer; display always leaves the drill-down
function setActiveLayer(id) {
  const sel = state.ui.selected;
  if (sel && (state.mode === 'display' || findAnnotation(sel.type, sel.id)?.layerId !== id)) clearSelection();
  if (state.ui.activeLayerId === id) return;
  state.ui.activeLayerId = id;
  if (state.ui.mergeSource) cancelMerge();
  renderLayerStrip();
  applyInteractivity();
  refreshLayerList();
}

// switch to an item's layer without dropping selection (panel / back navigation)
function followToLayer(type, id) {
  const item = findAnnotation(type, id);
  if (item) showLayer(item.layerId);
}

// restyles even when the layer is unchanged: the display drill-down depends on the selection
function showLayer(layerId) {
  if (layerId !== state.ui.activeLayerId) {
    state.ui.activeLayerId = layerId;
    if (state.ui.mergeSource) state.ui.mergeSource = null;
    renderLayerStrip();
  }
  applyInteractivity();
}

function moveToLayer(type, item, layerId) {
  if (item.layerId === layerId) return;
  pushHistory();
  item.layerId = layerId;
  renestAround(item);
  if (type === 'region') remountRegionLayer(item); // restack at new position
  followToLayer(type, item.id);
  scheduleSave();
}

function addLayer() {
  pushHistory();
  const layer = { id: generateId(), name: `Layer ${state.annotations.layers.length + 1}` };
  state.annotations.layers.push(layer);
  state.ui.activeLayerId = layer.id;
  renderLayerStrip();
  applyInteractivity();
  refreshLayerList();
  scheduleSave();
}

let pendingDelete = { id: null, timer: null };
function handleLayerDelete(id, closeEl) {
  if (pendingDelete.id === id) {
    clearTimeout(pendingDelete.timer);
    pendingDelete = { id: null, timer: null };
    deleteLayer(id);
    return;
  }
  if (pendingDelete.id) clearTimeout(pendingDelete.timer);
  closeEl.classList.add('confirm');
  pendingDelete.id = id;
  pendingDelete.timer = setTimeout(() => {
    closeEl.classList.remove('confirm');
    pendingDelete = { id: null, timer: null };
  }, 2500);
}

function deleteLayer(id) {
  if (state.annotations.layers.length <= 1) return;
  pushHistory();

  // remove all regions and pins in this layer (and their Leaflet layers)
  const removedIds = state.annotations.regions.filter(r => r.layerId === id).map(r => r.id);
  state.annotations.regions = state.annotations.regions.filter(r => {
    if (r.layerId !== id) return true;
    unmountRegion(r.id);
    return false;
  });
  state.annotations.pins = state.annotations.pins.filter(p => {
    if (p.layerId !== id) return true;
    layers.pins[p.id]?.remove();
    delete layers.pins[p.id];
    return false;
  });

  const idx = state.annotations.layers.findIndex(l => l.id === id);
  state.annotations.layers.splice(idx, 1);
  orphanChildrenOf(removedIds);

  if (state.ui.activeLayerId === id) {
    const fallback = state.annotations.layers[Math.max(0, idx - 1)];
    state.ui.activeLayerId = fallback.id;
  }
  if (state.ui.selected) clearSelection();

  renderLayerStrip();
  applyInteractivity();
  refreshLayerList();
  scheduleSave();
}

function startRenameLayer(id, nameEl) {
  nameEl.contentEditable = 'true';
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const commit = () => {
    nameEl.contentEditable = 'false';
    nameEl.removeEventListener('blur', commit);
    nameEl.removeEventListener('keydown', onKey);
    const layer = state.annotations.layers.find(l => l.id === id);
    const next  = nameEl.textContent.trim();
    if (layer && next && next !== layer.name) {
      pushHistory();
      layer.name = next;
      refreshLayerList();
      scheduleSave();
    } else if (layer) {
      nameEl.textContent = layer.name;
    }
  };
  const onKey = (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); nameEl.textContent = state.annotations.layers.find(l => l.id === id)?.name || ''; nameEl.blur(); }
  };
  nameEl.addEventListener('blur', commit);
  nameEl.addEventListener('keydown', onKey);
}

// INTERACTIVITY — what's clickable, faded, or framing the drill-down
//
// design: the active layer. display: the children of the region drilled into (on any layer);
// with nothing drilled into, the active layer. layer order only decides what draws on top.

// display mode's drill-down region: the selection if it has children, else the selection's parent
function drillFocus() {
  const sel = state.ui.selected;
  if (state.mode !== 'display' || !sel) return null;
  const item = findAnnotation(sel.type, sel.id);
  if (!item) return null;
  if (sel.type === 'region' && countInView(childrenInView(item.id))) return item;
  return parentInView(item);
}

// computed once per pass: the drill-down's children are collected up front
function interactivity() {
  const focus = drillFocus();
  if (!focus) return { focus, isLive: (it) => it.layerId === state.ui.activeLayerId };
  const { regions, pins } = childrenInView(focus.id);
  const live = new Set([...regions, ...pins].map(it => it.id));
  return { focus, isLive: (it) => live.has(it.id) };
}

function isLive(item) {
  return interactivity().isLive(item);
}

function itemElements(type, id) {
  if (type === 'pin') return [layers.pins[id]?.getElement()];
  const els = [];
  layers.regions[id]?.eachLayer(l => els.push(l.getElement()));
  return els;
}

function styleItem(type, item, ix) {
  const frame = ix.focus?.id === item.id;
  const dim   = !frame && !ix.isLive(item);
  for (const el of itemElements(type, item.id)) {
    el?.classList.toggle('layer-dim', dim);
    el?.classList.toggle('drill-frame', frame);
  }
}

function applyInteractivity() {
  const ix = interactivity();
  state.annotations.regions.forEach(r => styleItem('region', r, ix));
  state.annotations.pins.forEach(p => styleItem('pin', p, ix));
}

btnLayerAdd.addEventListener('click', addLayer);

// MODE

function setMode(mode) {
  if (mode === 'design' && shareLocked) return;
  state.mode = mode;
  if (mode === 'design') {
    toolsPanel.classList.remove('hidden');
    btnMode.textContent = 'Switch to Display Mode';
  } else {
    toolsPanel.classList.add('hidden');
    btnMode.textContent = 'Switch to Design Mode';
    setActiveTool(null);
    cancelRegionDraw();
  }
  const sel = state.ui.selected;
  if (sel && mode === 'display' && findAnnotation(sel.type, sel.id)?.hidden) { // can't stay selected once hidden
    navStack.length = 0;
    state.ui.selected = null;
  }
  applyLayerVisibility();
  renderLayerStrip();
  renderDetailPanel();
}

btnMode.addEventListener('click', () => {
  setMode(state.mode === 'design' ? 'display' : 'design');
});

// TOOLS

const TOOL_BTNS = {
  region: btnRegion,
  pin:    btnPin,
  wand:   btnWand,
  brush:  btnBrush,
  eraser: btnEraser,
  edit:   btnEdit,
};

function setActiveTool(tool) {
  state.ui.activeTool = tool;

  Object.values(TOOL_BTNS).forEach(b => b?.classList.remove('active'));
  if (tool) TOOL_BTNS[tool]?.classList.add('active');

  wandOptions?.classList.toggle('hidden', tool !== 'wand');
  brushControls?.classList.toggle('hidden', tool !== 'brush' && tool !== 'eraser');

  const isPaint = tool === 'brush' || tool === 'eraser';
  if (!isPaint) hideBrushCursor();
  map.getContainer().style.cursor = isPaint ? 'none' : (tool ? 'crosshair' : '');
  if (isPaint) map.dragging.disable(); else map.dragging.enable();
  if (isPaint) map.boxZoom.disable();  else map.boxZoom.enable(); // shift+drag belongs to the brush
  if (tool === 'region') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();

  if (tool !== 'region') cancelRegionDraw();
  if (tool !== 'wand')   setWandStatus('');
  if (tool !== 'edit')   exitVertexEdit();
}

function wireToolBtn(btn, name) {
  btn?.addEventListener('click', () => setActiveTool(state.ui.activeTool === name ? null : name));
}

wireToolBtn(btnRegion, 'region');
wireToolBtn(btnPin,    'pin');
wireToolBtn(btnWand,   'wand');
wireToolBtn(btnBrush,  'brush');
wireToolBtn(btnEraser, 'eraser');
wireToolBtn(btnEdit,   'edit');

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
const BASEMAP_URL = new URLSearchParams(location.search).get('map') || 'basemap.png';

// ifEmpty: a slow baseline must not replace an image uploaded while it was loading
function loadImageUrl(url, { ifEmpty = false } = {}) {
  const img = new Image();
  img.onload = () => {
    if (ifEmpty && state.image) return;
    sourceImage = img;
    applyImage(url, img.naturalWidth, img.naturalHeight);
  };
  img.onerror = () => { if (!ifEmpty) console.warn('Could not load map image:', url); };
  img.src = url;
}

function applyImage(url, width, height) {
  if (imageOverlay) imageOverlay.remove();
  mapBounds    = [[0, 0], [-height, width]];
  imageOverlay = L.imageOverlay(url, mapBounds).addTo(map);
  map.fitBounds(mapBounds);
  state.image  = { url, width, height };
  mapPlaceholder.classList.add('hidden');

  if (flags.restoredAwaitingImage) {
    mountAll();
    flags.restoredAwaitingImage = false;
  }
  renderDetailPanel();
}

// PINS

function addPin(latlng) {
  pushHistory();
  const pin = {
    id:      generateId(),
    latlng:  { lat: latlng.lat, lng: latlng.lng },
    label:   'New Pin',
    body:    '',
    hidden:  false,
    layerId: state.ui.activeLayerId,
  };
  state.annotations.pins.push(pin);
  renestAround(pin);
  mountPinLayer(pin);
  selectAnnotation('pin', pin.id);
  scheduleSave();
}

function mountPinLayer(pin, single = true) {
  const marker = L.marker([pin.latlng.lat, pin.latlng.lng]).addTo(map);
  marker.bindTooltip(escapeHtml(pin.label || 'Pin'), { direction: 'top', offset: [0, -28] });
  marker.on('click', (e) => {
    if (!isLive(pin)) return;
    L.DomEvent.stopPropagation(e);
    selectAnnotation('pin', pin.id);
  });
  layers.pins[pin.id] = marker;
  if (single) styleItem('pin', pin, interactivity());
}

function updatePinLayer(pin) {
  const marker = layers.pins[pin.id];
  if (!marker) return;
  marker.setTooltipContent(escapeHtml(pin.label || 'Pin'));
}

// REGIONS

const draw = {
  active:   false,
  points:   [],
  markers:  [],
  polyline: null,
};

const REGION_COLORS = [
  '#4a9eff', '#ff7c4a', '#4aff9e', '#ff4a7c',
  '#c04aff', '#ffe04a', '#4afff0', '#ff4adf',
];
let colorIndex = 0;
function nextColor() {
  return REGION_COLORS[colorIndex++ % REGION_COLORS.length];
}

// SWATCHES

const SWATCH_COLORS = [
  '#000000','#434343','#666666','#999999','#cccccc','#e6e6e6','#f3f3f3','#ffffff',
  '#ff0000','#ff7700','#ffff00','#00cc00','#00cccc','#4a9eff','#7700cc','#ff00cc',
  '#f4cccc','#fce5cd','#fff2cc','#d9ead3','#d0e0e3','#cfe2f3','#d9d2e9','#ead1dc',
  '#ea9999','#f9cb9c','#ffe599','#b6d7a8','#a2c4c9','#9fc5e8','#b4a7d6','#d5a6bd',
  '#cc0000','#e69138','#f1c232','#6aa84f','#45818e','#3d85c8','#674ea7','#a64d79',
];

function renderSwatchGrid(currentColor) {
  const cur = (currentColor || '#4a9eff').toLowerCase();
  const inPreset = SWATCH_COLORS.map(c => c.toLowerCase()).includes(cur);
  const swatches = SWATCH_COLORS.map(c => {
    const active = c.toLowerCase() === cur ? ' active' : '';
    return `<div class="swatch${active}" style="background:${c}" data-color="${c}" title="${c}"></div>`;
  }).join('');
  return `
    <div id="swatch-grid" class="swatch-grid">
      ${swatches}
      <div class="swatch swatch-custom${!inPreset ? ' active' : ''}" id="swatch-custom-btn" title="Custom colour">…</div>
    </div>
    <input id="edit-color-custom" type="color" value="${escapeHtml(currentColor || '#4a9eff')}" style="display:none" />
  `;
}

function bindSwatchGrid(annotation) {
  const grid        = document.getElementById('swatch-grid');
  const customBtn   = document.getElementById('swatch-custom-btn');
  const customInput = document.getElementById('edit-color-custom');
  const colorDot    = document.querySelector('.swatch-summary .color-dot');
  const syncDot     = (c) => { if (colorDot) colorDot.style.background = c; };

  grid.addEventListener('click', (e) => {
    const swatch = e.target.closest('[data-color]');
    if (!swatch) return;
    pushHistory();
    annotation.color = swatch.dataset.color;
    customInput.value = annotation.color;
    syncDot(annotation.color);
    grid.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');
    customBtn.classList.remove('active');
    updateRegionLayer(annotation);
    scheduleSave();
  });

  customBtn.addEventListener('click', () => customInput.click());

  customInput.addEventListener('focus', () => { pushHistory(); });
  customInput.addEventListener('input', (e) => {
    annotation.color = e.target.value;
    syncDot(annotation.color);
    grid.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
    customBtn.classList.add('active');
    updateRegionLayer(annotation);
    scheduleSave();
  });
}

const CLOSE_PX = 10; // click within this of the first vertex to close the shape

function startRegionDraw(latlng) {
  if (draw.active && draw.points.length) {
    const px = map.latLngToContainerPoint(latlng);
    const distTo = (p) => px.distanceTo(map.latLngToContainerPoint(p));
    if (draw.points.length >= 3 && distTo(draw.points[0]) < CLOSE_PX) { commitRegion(); return; }
    // ignore repeat clicks on the last vertex (e.g. the two clicks of a double-click)
    if (distTo(draw.points[draw.points.length - 1]) < 3) return;
  }
  if (!draw.active) {
    draw.active  = true;
    draw.points  = [];
    draw.markers = [];
  }
  draw.points.push(latlng);

  const dot = L.circleMarker(latlng, {
    radius: 4, color: '#fff', weight: 1.5,
    fillColor: '#4a9eff', fillOpacity: 1, interactive: false,
  }).addTo(map);
  draw.markers.push(dot);

  if (draw.polyline) draw.polyline.remove();
  if (draw.points.length > 1) {
    draw.polyline = L.polyline(draw.points, {
      color: '#4a9eff', weight: 1.5, dashArray: '4 4', interactive: false,
    }).addTo(map);
  }
}

function commitRegion() {
  if (draw.points.length < 3) { cancelRegionDraw(); return; }
  pushHistory();
  const region = {
    id:       generateId(),
    polygons: [draw.points.map(p => ({ lat: p.lat, lng: p.lng }))],
    color:    nextColor(),
    label:    'New Region',
    body:     '',
    hidden:   false,
    layerId:  state.ui.activeLayerId,
  };
  state.annotations.regions.push(region);
  renestAround(region);
  cancelRegionDraw();
  mountRegionLayer(region);
  selectAnnotation('region', region.id);
  scheduleSave();
}

function cancelRegionDraw() {
  draw.active = false;
  draw.points  = [];
  draw.markers.forEach(m => m.remove());
  draw.markers = [];
  if (draw.polyline) { draw.polyline.remove(); draw.polyline = null; }
}

function mountRegionLayer(region, single = true) {
  const group = L.featureGroup().addTo(map);

  for (const ring of region.polygons) {
    const poly = L.polygon(ring.map(p => [p.lat, p.lng]), {
      color:       region.color,
      weight:      1.5,
      fillColor:   region.color,
      fillOpacity: 0.18,
    });
    poly.bindTooltip(escapeHtml(region.label || 'Region'), { sticky: true });
    group.addLayer(poly);
  }

  group.on('click', (e) => {
    // creation tools and faded items pass the click through to the map
    if (['pin', 'region', 'wand'].includes(state.ui.activeTool)) return;
    if (!isLive(region)) return;
    L.DomEvent.stopPropagation(e);
    if (state.ui.mergeSource && state.ui.mergeSource !== region.id) {
      performMerge(state.ui.mergeSource, region.id);
      return;
    }
    selectAnnotation('region', region.id);
    if (state.ui.activeTool === 'edit') enterVertexEdit(region.id);
  });

  group.on('mouseover', () => {
    if (state.ui.mergeSource && state.ui.mergeSource !== region.id) {
      state.ui.mergeHover = region.id;
      renderDetailPanel();
    }
  });

  group.on('mouseout', () => {
    if (state.ui.mergeHover === region.id) {
      state.ui.mergeHover = null;
      renderDetailPanel();
    }
  });

  layers.regions[region.id] = group;
  if (!single) return;
  styleItem('region', region, interactivity());
  restackAbove(region);
}

// bulk mount (image load, undo/redo, locked share): restack and restyle once, not per item
function mountAll() {
  state.annotations.pins.forEach(p => mountPinLayer(p, false));
  state.annotations.regions.forEach(r => mountRegionLayer(r, false));
  applyLayerVisibility();
  applyZOrder();
}

function unmountRegion(id) {
  layers.regions[id]?.remove();
  delete layers.regions[id];
}

function updateRegionLayer(region) {
  const group = layers.regions[region.id];
  if (!group) return;
  group.eachLayer(poly => {
    poly.setTooltipContent(escapeHtml(region.label || 'Region'));
    poly.setStyle({ color: region.color, fillColor: region.color });
  });
}

function remountRegionLayer(region) {
  unmountRegion(region.id);
  mountRegionLayer(region);
}

function applyLayerVisibility() {
  const hide = state.mode === 'display';
  state.annotations.pins.forEach(pin => {
    const m = layers.pins[pin.id];
    if (!m) return;
    if (hide && pin.hidden) m.remove(); else m.addTo(map);
  });
  state.annotations.regions.forEach(region => {
    const g = layers.regions[region.id];
    if (!g) return;
    if (hide && region.hidden) g.remove(); else g.addTo(map);
  });
  applyInteractivity();
}

// MERGE

// Returns intersection polygons between every cross-pair of rings from two polygon arrays.
// Used to bridge small gaps before a union, so nearly-touching regions merge cleanly.
function buildBridges(polysA, polysB) {
  const bridges = [];
  for (const a of polysA) {
    for (const b of polysB) {
      try {
        const br = polygonClipping.intersection(
          ringToGeom(inflatePolygon(a, MERGE_BUFFER_PX)),
          ringToGeom(inflatePolygon(b, MERGE_BUFFER_PX)),
        );
        bridges.push(...br);
      } catch (err) {
        console.warn('bridge failed for pair, skipping:', err);
      }
    }
  }
  return bridges;
}

function startMerge(regionId) {
  state.ui.mergeSource = regionId;
  renderDetailPanel();
}

function cancelMerge() {
  if (!state.ui.mergeSource) return;
  state.ui.mergeSource = null;
  renderDetailPanel();
}

function performMerge(targetId, sourceId) {
  const target = state.annotations.regions.find(r => r.id === targetId);
  const source = state.annotations.regions.find(r => r.id === sourceId);
  if (!target || !source) { cancelMerge(); return; }
  if (target.layerId !== source.layerId) {
    setWandStatus('Merge blocked: regions are on different layers. Move one first.');
    cancelMerge();
    return;
  }
  pushHistory();

  if (typeof polygonClipping === 'undefined') {
    setWandStatus('Merge unavailable: polygon library failed to load.');
    cancelMerge();
    return;
  }

  const bridges = buildBridges(target.polygons, source.polygons);

  let merged;
  try {
    merged = polygonClipping.union(
      ...target.polygons.map(ringToGeom),
      ...source.polygons.map(ringToGeom),
      ...bridges,
    );
  } catch (err) {
    console.error('union failed:', err);
    setWandStatus('Merge failed: ' + (err.message || 'invalid geometry'));
    cancelMerge();
    return;
  }
  if (!merged?.length) { cancelMerge(); return; }

  // Each top-level component → one ring. Holes are dropped.
  target.polygons = merged.map(comp => comp[0].map(([lng, lat]) => ({ lat, lng })));

  state.annotations.regions = state.annotations.regions.filter(r => r.id !== sourceId);
  unmountRegion(sourceId);
  orphanChildrenOf([sourceId]);
  renestAround(target);
  remountRegionLayer(target);

  state.ui.mergeSource = targetId;
  state.ui.mergeHover  = null;
  selectAnnotation('region', targetId);
  scheduleSave();
}

// merge adjacent rings within a region (cleanup after duplicate fills / cascading adjacencies)
function consolidateRegion(regionId) {
  const region = state.annotations.regions.find(r => r.id === regionId);
  if (!region || region.polygons.length < 2) return;
  pushHistory();

  if (typeof polygonClipping === 'undefined') {
    setWandStatus('Consolidate unavailable: polygon library failed to load.');
    return;
  }

  const polys   = region.polygons;
  const bridges = [];
  for (let i = 0; i < polys.length; i++) {
    bridges.push(...buildBridges([polys[i]], polys.slice(i + 1)));
  }

  let result;
  try {
    result = polygonClipping.union(...polys.map(ringToGeom), ...bridges);
  } catch (err) {
    console.error('consolidate union failed:', err);
    return;
  }
  if (!result?.length) return;

  region.polygons = result.map(comp => comp[0].map(([lng, lat]) => ({ lat, lng })));
  renestAround(region);
  remountRegionLayer(region);
  selectAnnotation('region', regionId);
  scheduleSave();
}

// FLOOD REGION

function setWandStatus(msg) {
  if (wandStatus) wandStatus.textContent = msg;
}

function triggerWand(latlng) {
  if (!sourceImage || !workerReady) {
    setWandStatus('Still loading — try again in a moment.');
    return;
  }
  if (wandPending) return;

  const nativeX = Math.round(latlng.lng);
  const nativeY = Math.round(-latlng.lat);
  const { width, height } = state.image;

  const half = Math.floor(WINDOW / 2);
  const x0 = Math.max(0, Math.min(width  - WINDOW, nativeX - half));
  const y0 = Math.max(0, Math.min(height - WINDOW, nativeY - half));
  const ww = Math.min(WINDOW, width  - x0);
  const wh = Math.min(WINDOW, height - y0);

  const seedX = nativeX - x0;
  const seedY = nativeY - y0;
  if (seedX < 0 || seedX >= ww || seedY < 0 || seedY >= wh) return;

  const tmp = document.createElement('canvas');
  tmp.width  = ww;
  tmp.height = wh;
  const tmpCtx = tmp.getContext('2d', { willReadFrequently: true });
  tmpCtx.drawImage(sourceImage, x0, y0, ww, wh, 0, 0, ww, wh);
  const imageData = tmpCtx.getImageData(0, 0, ww, wh);

  wandOffset  = { x: x0, y: y0 };
  wandPending = true;
  startWandTicker();

  worker.postMessage({
    type: 'process',
    pixels: imageData.data.buffer,
    width: ww, height: wh,
    seedX, seedY,
    tolerance: parseFloat(wandTolerance?.value ?? 30),
    scale: 1,
  }, [imageData.data.buffer]);
}

function onWandResult({ points, simpCount, filled }) {
  wandPending = false;
  setWandStatus(`${simpCount} vertices · ${filled.toLocaleString()} px filled`);

  if (points.length < 3) {
    setWandStatus('Region too small — try a different spot or raise tolerance.');
    return;
  }

  const latlngs = points.map(p => ({
    lat: -(p.y + wandOffset.y),
    lng:   p.x + wandOffset.x,
  }));

  pushHistory();
  const region = {
    id:       generateId(),
    polygons: [latlngs],
    color:    nextColor(),
    label:    'New Region',
    body:     '',
    hidden:   false,
    layerId:  state.ui.activeLayerId,
  };
  state.annotations.regions.push(region);
  renestAround(region);
  mountRegionLayer(region);
  selectAnnotation('region', region.id);
  scheduleSave();
}

// DELETION

function deleteAnnotation(type, id) {
  pushHistory();
  if (type === 'pin') {
    state.annotations.pins = state.annotations.pins.filter(p => p.id !== id);
    layers.pins[id]?.remove();
    delete layers.pins[id];
  } else if (type === 'region') {
    state.annotations.regions = state.annotations.regions.filter(r => r.id !== id);
    unmountRegion(id);
    orphanChildrenOf([id]);
  }
  clearSelection();
  scheduleSave();
}

// HISTORY

function pushHistory() {
  const snap = JSON.stringify(state.annotations);
  if (historyStack.length && historyStack[historyStack.length - 1] === snap) return;
  historyStack.push(snap);
  if (historyStack.length > HISTORY_MAX) historyStack.shift();
}

// redo stays valid only while annotations are untouched since the last undo/redo.
// checked lazily rather than in pushHistory, since focus handlers push without editing
let restoredSnap = null;

function undo() {
  exitVertexEdit();
  const cur = JSON.stringify(state.annotations);
  if (cur !== restoredSnap) redoStack.length = 0;
  // skip no-op entries (focus pushes, cancelled merges) so undo always changes something
  while (historyStack.at(-1) === cur) historyStack.pop();
  if (!historyStack.length) return;
  redoStack.push(cur);
  restoreSnapshot(historyStack.pop());
}

function redo() {
  exitVertexEdit();
  const cur = JSON.stringify(state.annotations);
  if (cur !== restoredSnap) redoStack.length = 0;
  if (!redoStack.length) return;
  pushHistory();
  restoreSnapshot(redoStack.pop());
}

function restoreSnapshot(json) {
  const snap = JSON.parse(json);
  Object.values(layers.pins).forEach(m => m.remove());
  Object.values(layers.regions).forEach(g => g.remove());
  layers.pins    = {};
  layers.regions = {};
  state.annotations = snap;
  // active layer may no longer exist after undo/redo
  if (!state.annotations.layers.some(l => l.id === state.ui.activeLayerId)) {
    state.ui.activeLayerId = state.annotations.layers[0]?.id ?? null;
  }
  mountAll();
  renderLayerStrip();
  clearSelection();
  restoredSnap = JSON.stringify(state.annotations);
  scheduleSave();
}

// SELECTION / NAVIGATION

// selection is set before following so the restyle sees it
function selectAnnotation(type, id) {
  navStack.length = 0;
  state.ui.selected = { type, id };
  followToLayer(type, id);
  renderDetailPanel();
}

function navigateAnnotation(type, id) {
  if (state.ui.selected) navStack.push({ ...state.ui.selected });
  state.ui.selected = { type, id };
  followToLayer(type, id);
  renderDetailPanel();
}

function goBack() {
  if (!navStack.length) { if (state.mode === 'display') goUp(); else clearSelection(); return; }
  state.ui.selected = navStack.pop();
  followToLayer(state.ui.selected.type, state.ui.selected.id);
  renderDetailPanel();
}

function clearSelection() {
  navStack.length = 0;
  state.ui.selected = null;
  applyInteractivity();
  renderDetailPanel();
}

// display mode: climb one level of the tree; above the root, browse the root's layer
function goUp() {
  const sel    = state.ui.selected;
  const parent = sel && parentInView(findAnnotation(sel.type, sel.id));
  if (parent) selectAnnotation('region', parent.id);
  else clearSelection();
}

// DETAIL PANEL

function renderDetailPanel() {
  const sel = state.ui.selected;

  if (state.ui.mergeSource && state.ui.mergeHover
      && state.ui.mergeSource !== state.ui.mergeHover) {
    const source = state.annotations.regions.find(r => r.id === state.ui.mergeSource);
    const target = state.annotations.regions.find(r => r.id === state.ui.mergeHover);
    if (source && target) { renderDetailTree(null); renderMergePreview(source, target); return; }
  }

  setPanelVisible(!!sel || showsLayerList());
  detailHeader.textContent = sel ? 'Details' : 'Layer';

  if (!sel) {
    renderDetailTree(null);
    if (showsLayerList()) renderLayerList();
    else detailContent.innerHTML = '<p class="detail-empty">Click a region or pin to see details.</p>';
    return;
  }

  const list = sel.type === 'region' ? state.annotations.regions : state.annotations.pins;
  const annotation = list.find(a => a.id === sel.id);
  if (!annotation) { clearSelection(); return; }

  renderDetailTree(annotation);

  if (state.mode === 'design') {
    renderDetailEditor(annotation, sel.type);
  } else {
    renderDetailView(annotation);
  }
}

// LAYER LIST (right panel, nothing selected)

function showsLayerList() {
  return state.mode === 'design' && !!state.image;
}

function setPanelVisible(visible) {
  if (detailPanel.classList.contains('hidden') !== visible) return;
  detailPanel.classList.toggle('hidden', !visible);
  map.invalidateSize(); // map container width changed
}

// re-render the list if it's what the panel is showing
function refreshLayerList() {
  if (!state.ui.selected) renderDetailPanel();
}

function renderLayerList() {
  const layer   = state.annotations.layers.find(l => l.id === state.ui.activeLayerId);
  const regions = state.annotations.regions.filter(r => r.layerId === layer?.id);
  const pins    = state.annotations.pins.filter(p => p.layerId === layer?.id);

  const row = (type, a) => `
    <div class="pin-list-item item-row${a.hidden ? ' item-hidden' : ''}" data-type="${type}" data-id="${escapeHtml(a.id)}">
      ${type === 'region' ? `<span class="color-wheel" style="background:${escapeHtml(a.color || '#4a9eff')}"></span>` : ''}
      <span class="item-row-label">${escapeHtml(a.label || (type === 'region' ? 'Untitled region' : 'Untitled pin'))}</span>
      ${a.parentId ? `<span class="item-row-parent">in ${escapeHtml(findItem(a.parentId)?.label || 'Untitled')}</span>` : ''}
    </div>`;
  const section = (title, type, items) => items.length ? `
    <details class="pin-list" open>
      <summary class="pin-list-summary">${title} (${items.length})</summary>
      ${items.map(a => row(type, a)).join('')}
    </details>` : '';

  const sections = section('Regions', 'region', regions) + section('Pins', 'pin', pins);
  detailContent.innerHTML = `
    <h2 class="detail-title">${escapeHtml(layer?.name || 'Layer')}</h2>
    ${sections || '<p class="detail-empty">Nothing on this layer yet.</p>'}
    <div class="editor-actions renest-actions">
      <button id="renest-layer" class="btn-secondary" title="Re-run automatic nesting for this layer's items (manual parents are kept)">Re-nest layer</button>
      <button id="renest-all" class="btn-secondary" title="Re-run automatic nesting for every item (manual parents are kept)">Re-nest all</button>
    </div>
  `;

  const bindRenest = (btnId, layerId) => {
    document.getElementById(btnId)?.addEventListener('click', () => {
      pushHistory();
      renestAll(layerId);
      scheduleSave();
      renderLayerList();
      const btn = document.getElementById(btnId);
      if (btn) { btn.textContent = 'Done'; setTimeout(() => { btn.textContent = btnId === 'renest-all' ? 'Re-nest all' : 'Re-nest layer'; }, 1200); }
    });
  };
  bindRenest('renest-layer', layer?.id);
  bindRenest('renest-all', null);

  detailContent.querySelectorAll('.item-row').forEach(el => {
    el.addEventListener('click', () => {
      const { type, id } = el.dataset;
      selectAnnotation(type, id);
      panToItem(type, id);
    });
  });
}

// descriptions can arrive in share links: markdown output is sanitized, or shown as plain text
function bodyHtml(body) {
  if (!body) return '<em style="color:#888">No description.</em>';
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return escapeHtml(body);
  return DOMPurify.sanitize(marked.parse(body));
}

function renderMergePreview(source, target) {
  detailContent.innerHTML = `
    <div class="merge-banner">
      Click to merge into
      <span class="color-wheel" style="background:${escapeHtml(source.color || '#4a9eff')}"></span>
      <strong>${escapeHtml(source.label || 'Untitled')}</strong>
    </div>
    <h2 class="merge-target-title">
      <span class="color-wheel" style="background:${escapeHtml(target.color || '#4a9eff')}"></span>
      ${escapeHtml(target.label || 'Untitled')}
    </h2>
    <div class="detail-body markdown-body">${bodyHtml(target.body)}</div>
  `;
}

function backButtonHtml() {
  if (!navStack.length && state.mode === 'display') {
    const sel    = state.ui.selected;
    const parent = sel && parentInView(findAnnotation(sel.type, sel.id));
    return parent ? `<button id="nav-back" class="btn-back">← ${escapeHtml(parent.label || 'Untitled')}</button>` : '';
  }
  if (!navStack.length) {
    if (!showsLayerList()) return '';
    const layer = state.annotations.layers.find(l => l.id === state.ui.activeLayerId);
    return `<button id="nav-back" class="btn-back">← ${escapeHtml(layer?.name || 'Layer')}</button>`;
  }
  const prev = navStack[navStack.length - 1];
  const list = prev.type === 'region' ? state.annotations.regions : state.annotations.pins;
  const label = list.find(a => a.id === prev.id)?.label || 'Untitled';
  return `<button id="nav-back" class="btn-back">← ${escapeHtml(label)}</button>`;
}

function bindBackButton() {
  document.getElementById('nav-back')?.addEventListener('click', goBack);
}

function renderDetailView(annotation) {
  detailContent.innerHTML = `
    ${backButtonHtml()}
    <h2 class="detail-title">${escapeHtml(annotation.label || 'Untitled')}</h2>
    <hr class="detail-divider" />
    <div class="detail-body markdown-body">${bodyHtml(annotation.body)}</div>
  `;
  bindBackButton();
}

function renderDetailEditor(annotation, type) {
  const isRegion = type === 'region';

  const colorSwatch = isRegion ? `
    <details class="swatch-details">
      <summary class="swatch-summary">
        <span class="field-label" style="display:inline">Color</span>
        <span class="color-dot" style="background:${escapeHtml(annotation.color || '#4a9eff')}"></span>
      </summary>
      ${renderSwatchGrid(annotation.color)}
    </details>` : '';

  const mergeBanner = (isRegion && state.ui.mergeSource === annotation.id)
    ? `<div class="merge-banner">
         Click another region to merge into this one.
         <button id="edit-merge-cancel" class="btn-link">Cancel</button>
       </div>`
    : '';

  const layerSelect = state.annotations.layers.length > 1 ? `
    <label class="field-label" for="edit-layer">Layer</label>
    <select id="edit-layer" class="field-input">
      ${state.annotations.layers.map(l => `
        <option value="${escapeHtml(l.id)}" ${l.id === annotation.layerId ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}
    </select>` : '';

  const parentSelect = (() => {
    const auto      = autoParent(annotation);
    const autoLabel = auto ? escapeHtml(findItem(auto)?.label || 'Untitled') : 'top level';
    const current   = annotation.parentManual ? (annotation.parentId ?? '__none') : '';
    const groups    = state.annotations.layers
      .filter(l => type === 'pin' || l.id !== annotation.layerId) // pins may sit in a same-layer region
      .map(l => {
        const opts = state.annotations.regions
          .filter(r => r.layerId === l.id && !wouldCycle(annotation.id, r.id))
          .map(r => `<option value="${escapeHtml(r.id)}" ${current === r.id ? 'selected' : ''}>${escapeHtml(r.label || 'Untitled')}</option>`)
          .join('');
        return opts ? `<optgroup label="${escapeHtml(l.name)}">${opts}</optgroup>` : '';
      }).join('');
    return `
      <label class="field-label" for="edit-parent">Parent</label>
      <select id="edit-parent" class="field-input">
        <option value="" ${current === '' ? 'selected' : ''}>Auto (${autoLabel})</option>
        <option value="__none" ${current === '__none' ? 'selected' : ''}>None (top level)</option>
        ${groups}
      </select>`;
  })();

  const polyCount = isRegion ? annotation.polygons.length : 0;
  const polyHint  = isRegion
    ? `<div class="field-label" style="margin-top:6px">${polyCount} polygon${polyCount === 1 ? '' : 's'}</div>`
    : '';

  const actionBtns = isRegion ? `
    <button id="edit-merge" class="btn-secondary">Merge…</button>
    ${polyCount > 1 ? `<button id="edit-consolidate" class="btn-secondary">Consolidate</button>` : ''}
    <button id="edit-delete" class="btn-danger">Delete</button>
  ` : `<button id="edit-delete" class="btn-danger">Delete</button>`;

  detailContent.innerHTML = `
    ${backButtonHtml()}
    <div class="detail-editor">
      ${mergeBanner}

      <label class="field-label" for="edit-label">Label</label>
      <input id="edit-label" type="text" class="field-input"
             value="${escapeHtml(annotation.label || '')}" placeholder="Label…" />

      ${layerSelect}
      ${parentSelect}
      ${colorSwatch}
      ${polyHint}

      <label class="field-label" for="edit-body">Description <span class="field-hint">(Markdown)</span></label>
      <textarea id="edit-body" class="field-textarea"
                placeholder="Description…">${escapeHtml(annotation.body || '')}</textarea>

      <label class="field-toggle" for="edit-hidden">
        <input id="edit-hidden" type="checkbox" ${annotation.hidden ? 'checked' : ''} />
        Hide in display mode
      </label>

      <div class="editor-actions">${actionBtns}</div>
    </div>
  `;

  const labelInput  = document.getElementById('edit-label');
  const bodyInput   = document.getElementById('edit-body');
  const hiddenCheck = document.getElementById('edit-hidden');

  labelInput.addEventListener('focus', pushHistory);
  labelInput.addEventListener('input', () => {
    annotation.label = labelInput.value;
    if (type === 'pin')    updatePinLayer(annotation);
    if (type === 'region') updateRegionLayer(annotation);
    scheduleSave();
  });

  bodyInput.addEventListener('focus', pushHistory);
  bodyInput.addEventListener('input', () => {
    annotation.body = bodyInput.value;
    scheduleSave();
  });

  hiddenCheck.addEventListener('change', () => {
    pushHistory();
    annotation.hidden = hiddenCheck.checked;
    applyLayerVisibility();
    scheduleSave();
  });

  document.getElementById('edit-layer')?.addEventListener('change', (e) => {
    moveToLayer(type, annotation, e.target.value);
    renderDetailPanel(); // parent options depend on the layer
  });

  document.getElementById('edit-parent')?.addEventListener('change', (e) => {
    pushHistory();
    const v = e.target.value;
    if (v === '') {
      annotation.parentManual = false;
      renest([annotation]);
    } else {
      annotation.parentManual = true;
      annotation.parentId     = v === '__none' ? null : v;
    }
    scheduleSave();
    renderDetailTree(annotation);
  });

  if (isRegion) bindSwatchGrid(annotation);

  document.getElementById('edit-delete').addEventListener('click', () => {
    deleteAnnotation(type, annotation.id);
  });

  document.getElementById('edit-merge')?.addEventListener('click', () => {
    startMerge(annotation.id);
  });

  document.getElementById('edit-merge-cancel')?.addEventListener('click', cancelMerge);

  document.getElementById('edit-consolidate')?.addEventListener('click', () => {
    consolidateRegion(annotation.id);
  });

  bindBackButton();
  labelInput.focus();
  labelInput.select();
}

// NESTING TREE (breadcrumb + nested children above the details)

function visibleInMode(it) {
  return state.mode !== 'display' || !it.hidden;
}

// children as the current mode shows them: a hidden child is skipped and its children take its place
function childrenInView(id, seen = new Set([id])) {
  const { regions, pins } = childrenOf(id);
  const out = { regions: [], pins: pins.filter(visibleInMode) };
  for (const r of regions) {
    if (visibleInMode(r)) { out.regions.push(r); continue; }
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const sub = childrenInView(r.id, seen);
    out.regions.push(...sub.regions);
    out.pins.push(...sub.pins);
  }
  return out;
}

const countInView = ({ regions, pins }) => regions.length + pins.length;

// nearest ancestor the current mode shows
function parentInView(item) {
  return item ? ancestorsOf(item).filter(visibleInMode).at(-1) ?? null : null;
}

function treeLinkHtml(type, item) {
  const dot = type === 'region'
    ? `<span class="color-wheel" style="background:${escapeHtml(item.color || '#4a9eff')}"></span>` : '';
  const fallback = type === 'region' ? 'Untitled region' : 'Untitled pin';
  return `<span class="tree-link" data-type="${type}" data-id="${escapeHtml(item.id)}">${dot}${escapeHtml(item.label || fallback)}</span>`;
}

// regions expand in place (<details>) when they have children of their own
function childNodesHtml(kids, seen) {
  const regionHtml = kids.regions.map(r => {
    const sub   = childrenInView(r.id);
    const count = seen.has(r.id) ? 0 : countInView(sub);
    if (!count) return `<div class="tree-leaf">${treeLinkHtml('region', r)}</div>`;
    return `
      <details class="tree-node">
        <summary>${treeLinkHtml('region', r)} <span class="tree-count">${count}</span></summary>
        <div class="tree-children">${childNodesHtml(sub, new Set([...seen, r.id]))}</div>
      </details>`;
  }).join('');
  const pinHtml = kids.pins
    .map(p => `<div class="tree-leaf tree-pin">${treeLinkHtml('pin', p)}</div>`).join('');
  return regionHtml + pinHtml;
}

function renderTreeHtml(item) {
  const crumbs = ancestorsOf(item).filter(visibleInMode);
  const crumbHtml = crumbs.length
    ? `<div class="tree-crumbs">${crumbs.map(a => treeLinkHtml('region', a)).join('<span class="tree-sep">›</span>')}</div>`
    : '';
  const kids  = item.polygons ? childrenInView(item.id) : { regions: [], pins: [] };
  const count = countInView(kids);
  const kidsHtml = count ? `
    <details class="pin-list" open>
      <summary class="pin-list-summary">Contains (${count})</summary>
      <div class="tree-children">${childNodesHtml(kids, new Set([item.id]))}</div>
    </details>` : '';
  return crumbHtml + kidsHtml;
}

function panToItem(type, id) {
  const item = findAnnotation(type, id);
  if (type === 'pin' && item) map.panTo(item.latlng);
  if (type === 'region') {
    const bounds = layers.regions[id]?.getBounds();
    if (bounds?.isValid()) map.panTo(bounds.getCenter());
  }
}

function renderDetailTree(item) {
  if (!detailTree) return;
  const html = item ? renderTreeHtml(item) : '';
  detailTree.innerHTML = html;
  detailTree.classList.toggle('hidden', !html);
  detailTree.querySelectorAll('.tree-link').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault(); // don't toggle the <details> the link sits in
      e.stopPropagation();
      const { type, id } = el.dataset;
      if (!findAnnotation(type, id)) return;
      navigateAnnotation(type, id);
      panToItem(type, id);
    });
  });
}

// refresh nesting views after links change, without re-rendering (and refocusing) the editor
function refreshTree() {
  const sel = state.ui.selected;
  if (sel) renderDetailTree(findAnnotation(sel.type, sel.id));
  else refreshLayerList();
}

// MAP EVENTS

// display: a click outside the drill-down (or the selection) leaves it for the outermost layer.
// clicks inside it reach here through faded items and the frame, and are ignored
function onDisplayMapClick(latlng) {
  const sel = state.ui.selected;
  if (!sel) return;
  const area = drillFocus() ?? (sel.type === 'region' ? findAnnotation('region', sel.id) : null);
  if (area?.polygons.some(ring => pointInRing(latlng, ring))) return;
  showLayer(state.annotations.layers[0].id);
  clearSelection();
}

map.on('click', (e) => {
  if (state.mode !== 'design') { onDisplayMapClick(e.latlng); return; }
  if      (state.ui.activeTool === 'pin')    addPin(e.latlng);
  else if (state.ui.activeTool === 'region') startRegionDraw(e.latlng);
  else if (state.ui.activeTool === 'wand')   triggerWand(e.latlng);
  else if (state.ui.mergeSource)             cancelMerge();
  else                                        clearSelection();
});

map.on('dblclick', (e) => {
  if (state.mode !== 'design') return;
  if (state.ui.activeTool === 'region') {
    L.DomEvent.stopPropagation(e);
    commitRegion();
  }
});

// text fields the user has typed in keep native ctrl+z (fields are rebuilt on each render)
const typedFields = new WeakSet();
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.type === 'text') typedFields.add(t);
});

document.addEventListener('keydown', (e) => {
  const key    = e.key?.toLowerCase();
  const isUndo = (e.metaKey || e.ctrlKey) && key === 'z' && !e.shiftKey;
  const isRedo = ((e.metaKey || e.ctrlKey) && key === 'z' && e.shiftKey) || (e.ctrlKey && key === 'y');
  if (isUndo || isRedo) {
    if (typedFields.has(e.target)) return;
    e.preventDefault();
    if (isUndo) undo(); else redo();
    return;
  }
  if (e.key !== 'Escape') return;
  // esc unwinds the innermost thing first; deselect only when nothing else was cancelled
  const busy = draw.active || state.ui.mergeSource || vertexEdit.active || state.ui.activeTool === 'edit';
  if (draw.active)            cancelRegionDraw();
  if (state.ui.mergeSource)   cancelMerge();
  if (vertexEdit.active)      exitVertexEdit();
  if (state.ui.activeTool === 'edit') setActiveTool(null);
  if (busy || !state.ui.selected || e.target.isContentEditable) return; // layer rename handles its own esc
  if (typedFields.has(e.target)) { e.target.blur(); return; }       // first esc leaves a field you typed in
  if (state.mode === 'display') goUp(); else clearSelection();
});

// VERTEX EDIT

function refreshRegionGeometry(region) {
  const group = layers.regions[region.id];
  if (!group) return;
  const polys = [];
  group.eachLayer(l => polys.push(l));
  region.polygons.forEach((ring, i) => {
    if (polys[i]) polys[i].setLatLngs(ring.map(p => [p.lat, p.lng]));
  });
}

function updateMidpointPositions(region) {
  let mIdx = 0;
  region.polygons.forEach((ring) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
      if (vertexEdit.midHandles[mIdx]) {
        vertexEdit.midHandles[mIdx].setLatLng([mid.lat, mid.lng]);
      }
      mIdx++;
    }
  });
}

function enterVertexEdit(regionId) {
  exitVertexEdit();
  const region = state.annotations.regions.find(r => r.id === regionId);
  if (!region) return;
  vertexEdit.active   = true;
  vertexEdit.regionId = regionId;

  region.polygons.forEach((ring, ringIdx) => {
    ring.forEach((pt, ptIdx) => {
      const handle = L.marker([pt.lat, pt.lng], {
        draggable: true,
        icon: L.divIcon({ className: 'vertex-handle', iconSize: [10, 10], iconAnchor: [5, 5] }),
        zIndexOffset: 1000,
      }).addTo(map);

      handle.on('dragstart', () => { pushHistory(); });
      handle.on('drag', (e) => {
        const ll = e.target.getLatLng();
        region.polygons[ringIdx][ptIdx] = { lat: ll.lat, lng: ll.lng };
        refreshRegionGeometry(region);
        updateMidpointPositions(region);
      });
      handle.on('dragend', () => { renestAround(region); refreshTree(); scheduleSave(); });
      handle.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (ring.length <= 3) return;
        pushHistory();
        region.polygons[ringIdx].splice(ptIdx, 1);
        renestAround(region);
        remountRegionLayer(region);
        enterVertexEdit(regionId);
        scheduleSave();
      });

      vertexEdit.handles.push(handle);
    });

    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
      const insertIdx = i + 1;

      const mHandle = L.marker([mid.lat, mid.lng], {
        draggable: false,
        icon: L.divIcon({ className: 'midpoint-handle', iconSize: [8, 8], iconAnchor: [4, 4] }),
        zIndexOffset: 900,
      }).addTo(map);

      mHandle.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        pushHistory();
        region.polygons[ringIdx].splice(insertIdx, 0, { lat: mid.lat, lng: mid.lng });
        remountRegionLayer(region);
        enterVertexEdit(regionId);
        scheduleSave();
      });

      vertexEdit.midHandles.push(mHandle);
    }
  });
}

function exitVertexEdit() {
  vertexEdit.handles.forEach(h => h.remove());
  vertexEdit.midHandles.forEach(h => h.remove());
  vertexEdit.handles    = [];
  vertexEdit.midHandles = [];
  vertexEdit.active     = false;
  vertexEdit.regionId   = null;
}

// BRUSH / ERASER

function screenToBrushRadius() {
  const center = map.getSize().divideBy(2);
  const a = map.containerPointToLatLng(center);
  const b = map.containerPointToLatLng(center.add([brushSizePx, 0]));
  return Math.abs(b.lng - a.lng);
}

function updateBrushCursor(latlng) {
  const r   = screenToBrushRadius();
  const pts = circlePoly(latlng, r);
  if (brushCursorLayer) {
    brushCursorLayer.setLatLngs(pts.map(p => [p.lat, p.lng]));
  } else {
    brushCursorLayer = L.polygon(pts.map(p => [p.lat, p.lng]), {
      color:       '#fff',
      weight:      1.5,
      dashArray:   '5 4',
      fill:        false,
      interactive: false,
    }).addTo(map);
  }
}

function hideBrushCursor() {
  if (brushCursorLayer) { brushCursorLayer.remove(); brushCursorLayer = null; }
}

// forceNew (shift+drag) starts a fresh region instead of extending the selection
function applyBrush(latlng, forceNew = false) {
  if (typeof polygonClipping === 'undefined') return;

  const r          = screenToBrushRadius();
  const circlePts  = circlePoly(latlng, r);
  const circleGeom = [circlePts.map(p => [p.lng, p.lat])];

  let region = null;
  let isNew  = false;
  if (!forceNew && state.ui.selected?.type === 'region') {
    region = state.annotations.regions.find(r2 => r2.id === state.ui.selected.id);
    if (region?.layerId !== state.ui.activeLayerId) region = null;
  }
  if (!region) {
    region = {
      id:       generateId(),
      polygons: [],
      color:    nextColor(),
      label:    'New Region',
      body:     '',
      hidden:   false,
      layerId:  state.ui.activeLayerId,
    };
    state.annotations.regions.push(region);
    isNew = true;
  }

  let result;
  try {
    if (region.polygons.length === 0) {
      result = polygonClipping.union(circleGeom);
    } else {
      result = polygonClipping.union(...region.polygons.map(ringToGeom), circleGeom);
    }
  } catch (err) {
    console.warn('brush union failed:', err);
    return;
  }
  if (!result?.length) return;

  region.polygons = result.map(comp => comp[0].map(([lng, lat]) => ({ lat, lng })));
  strokeTouched.add(region.id);
  remountRegionLayer(region);
  if (isNew) selectAnnotation('region', region.id);
  scheduleSave();
}

function applyEraser(latlng) {
  if (typeof polygonClipping === 'undefined') return;

  const r          = screenToBrushRadius();
  const circlePts  = circlePoly(latlng, r);
  const circleGeom = [circlePts.map(p => [p.lng, p.lat])];

  state.annotations.regions.forEach(region => {
    if (!region.polygons.length) return;
    if (region.layerId !== state.ui.activeLayerId) return; // eraser is locked to active layer

    const group = layers.regions[region.id];
    if (group) {
      try {
        const bounds = group.getBounds();
        if (!bounds.isValid()) return;
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const closestLat = Math.max(sw.lat, Math.min(ne.lat, latlng.lat));
        const closestLng = Math.max(sw.lng, Math.min(ne.lng, latlng.lng));
        if (latlngDist(latlng, { lat: closestLat, lng: closestLng }) > r) return;
      } catch (_) { /* getBounds can throw if group empty */ }
    }

    let result;
    try {
      result = polygonClipping.difference(region.polygons.map(ringToGeom), circleGeom);
    } catch (err) {
      console.warn('eraser difference failed:', err);
      return;
    }

    if (!result?.length) {
      state.annotations.regions = state.annotations.regions.filter(r2 => r2.id !== region.id);
      unmountRegion(region.id);
      strokeDeleted.add(region.id);
      if (state.ui.selected?.id === region.id) clearSelection();
      else refreshLayerList();
      scheduleSave();
      return;
    }

    region.polygons = result.map(comp => comp[0].map(([lng, lat]) => ({ lat, lng })));
    strokeTouched.add(region.id);
    remountRegionLayer(region);
    scheduleSave();
  });
}

const strokeTouched = new Set(); // region ids reshaped during the current brush/eraser stroke
const strokeDeleted = new Set(); // region ids erased away during the current stroke

function endStroke() {
  if (!brushPainting) return;
  brushPainting   = false;
  brushLastLatLng = null;
  if (strokeDeleted.size) orphanChildrenOf([...strokeDeleted]);
  for (const id of strokeTouched) {
    const region = state.annotations.regions.find(r => r.id === id);
    if (region) renestAround(region);
  }
  strokeTouched.clear();
  strokeDeleted.clear();
  refreshTree();
  scheduleSave();
}

map.on('mousedown', (e) => {
  if (state.mode !== 'design') return;
  const tool = state.ui.activeTool;
  if (tool !== 'brush' && tool !== 'eraser') return;
  brushPainting   = true;
  brushLastLatLng = e.latlng;
  pushHistory();
  if (tool === 'brush')  applyBrush(e.latlng, e.originalEvent.shiftKey);
  if (tool === 'eraser') applyEraser(e.latlng);
});

map.on('mousemove', (e) => {
  const tool = state.ui.activeTool;
  if (tool === 'brush' || tool === 'eraser') updateBrushCursor(e.latlng);

  if (!brushPainting) return;
  if (state.mode !== 'design') return;

  const r = screenToBrushRadius();
  if (latlngDist(e.latlng, brushLastLatLng) < r * 0.5) return;
  brushLastLatLng = e.latlng;

  if (tool === 'brush')  applyBrush(e.latlng);
  if (tool === 'eraser') applyEraser(e.latlng);
});

map.on('mouseup',  endStroke);
map.on('mouseout', endStroke);

// INIT

initWorker();

const hashData  = location.hash.slice(1);
const fromShare = hashData && await loadShareHash(hashData);
if (fromShare) {
  colorIndex = state.annotations.regions.length;
  if (shareLocked) btnMode.style.display = 'none';
  else flags.restoredAwaitingImage = true; // defer mount until image upload
  updatePlaceholder();
} else {
  const hadStored = loadAnnotations();
  if (hadStored) {
    colorIndex = state.annotations.regions.length;
    flags.restoredAwaitingImage = true;
    updatePlaceholder();
  }
}

// guarantee at least one layer + a valid active layer (fresh maps land here too)
ensureLayers(state.annotations);
ensureNesting();
state.ui.activeLayerId = state.annotations.layers[0].id;
renderLayerStrip();

// locked share with no image: mount now so viewer can interact with annotations
if (fromShare && shareLocked) mountAll();

setMode('display');
if (typeof lucide !== 'undefined') lucide.createIcons();
loadImageUrl(BASEMAP_URL, { ifEmpty: true }); // missing file: the placeholder stays up
