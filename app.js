import { state, layers, historyStack, navStack, HISTORY_MAX } from './state.js';
import { generateId, escapeHtml, pinsInRegion,
         circlePoly, latlngDist, ringToGeom, MERGE_BUFFER_PX, inflatePolygon } from './utils.js';
import { flags, scheduleSave, loadAnnotations, clearSavedAnnotations } from './persistence.js';

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

let brushSizePx      = 30;
const vertexEdit     = { active: false, regionId: null, handles: [], midHandles: [] };
let brushCursorLayer = null;
let brushPainting    = false;
let brushLastLatLng  = null;

// DOM

const toolsPanel       = document.getElementById('tools-panel');
const detailPanel      = document.getElementById('detail-panel');
const detailContent    = document.getElementById('detail-content');
const detailTree       = document.getElementById('detail-tree');
const mapPlaceholder   = document.getElementById('map-placeholder');
const btnMode          = document.getElementById('btn-mode');
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
      updatePlaceholder();
    });
  } else {
    ph.innerHTML = '<p>No map loaded.<br/>Switch to Design Mode and upload an image.</p>';
  }
}

// MODE

function setMode(mode) {
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
  applyLayerVisibility();
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
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    sourceImage = img;
    applyImage(url, img.naturalWidth, img.naturalHeight);
  };
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
    state.annotations.pins.forEach(mountPinLayer);
    state.annotations.regions.forEach(mountRegionLayer);
    flags.restoredAwaitingImage = false;
  }
}

// PINS

function addPin(latlng) {
  pushHistory();
  const pin = {
    id:     generateId(),
    latlng: { lat: latlng.lat, lng: latlng.lng },
    label:  'New Pin',
    body:   '',
    hidden: false,
  };
  state.annotations.pins.push(pin);
  mountPinLayer(pin);
  selectAnnotation('pin', pin.id);
  scheduleSave();
}

function mountPinLayer(pin) {
  const marker = L.marker([pin.latlng.lat, pin.latlng.lng]).addTo(map);
  marker.bindTooltip(pin.label || 'Pin', { direction: 'top', offset: [0, -28] });
  marker.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    selectAnnotation('pin', pin.id);
  });
  layers.pins[pin.id] = marker;
}

function updatePinLayer(pin) {
  const marker = layers.pins[pin.id];
  if (!marker) return;
  marker.setTooltipContent(pin.label || 'Pin');
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
    <input id="edit-color-custom" type="color" value="${currentColor || '#4a9eff'}" style="display:none" />
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

function startRegionDraw(latlng) {
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
  };
  state.annotations.regions.push(region);
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

function mountRegionLayer(region) {
  const group = L.featureGroup().addTo(map);

  for (const ring of region.polygons) {
    const poly = L.polygon(ring.map(p => [p.lat, p.lng]), {
      color:       region.color,
      weight:      1.5,
      fillColor:   region.color,
      fillOpacity: 0.18,
    });
    poly.bindTooltip(region.label || 'Region', { sticky: true });
    group.addLayer(poly);
  }

  group.on('click', (e) => {
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
}

function updateRegionLayer(region) {
  const group = layers.regions[region.id];
  if (!group) return;
  group.eachLayer(poly => {
    poly.setTooltipContent(region.label || 'Region');
    poly.setStyle({ color: region.color, fillColor: region.color });
  });
}

function remountRegionLayer(region) {
  layers.regions[region.id]?.remove();
  delete layers.regions[region.id];
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
}

// MERGE

// bridges between every cross-pair; empty = non-adjacent (kept as separate rings)
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
  layers.regions[sourceId]?.remove();
  delete layers.regions[sourceId];
  layers.regions[targetId]?.remove();
  delete layers.regions[targetId];
  mountRegionLayer(target);

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
  layers.regions[regionId]?.remove();
  delete layers.regions[regionId];
  mountRegionLayer(region);
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
  };
  state.annotations.regions.push(region);
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
    layers.regions[id]?.remove();
    delete layers.regions[id];
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

function undo() {
  exitVertexEdit();
  if (!historyStack.length) return;
  const snap = JSON.parse(historyStack.pop());
  Object.values(layers.pins).forEach(m => m.remove());
  Object.values(layers.regions).forEach(g => g.remove());
  layers.pins    = {};
  layers.regions = {};
  state.annotations = snap;
  state.annotations.pins.forEach(mountPinLayer);
  state.annotations.regions.forEach(mountRegionLayer);
  applyLayerVisibility();
  clearSelection();
  scheduleSave();
}

// SELECTION/DETAILS

function selectAnnotation(type, id) {
  navStack.length = 0;
  state.ui.selected = { type, id };
  detailPanel.classList.remove('hidden');
  renderDetailPanel();
}

function navigateAnnotation(type, id) {
  if (state.ui.selected) navStack.push({ ...state.ui.selected });
  state.ui.selected = { type, id };
  detailPanel.classList.remove('hidden');
  renderDetailPanel();
}

function goBack() {
  if (!navStack.length) return;
  state.ui.selected = navStack.pop();
  renderDetailPanel();
}

function clearSelection() {
  navStack.length = 0;
  state.ui.selected = null;
  detailPanel.classList.add('hidden');
  renderDetailPanel();
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

  if (!sel) {
    renderDetailTree(null);
    detailContent.innerHTML = '<p class="detail-empty">Click a region or pin to see details.</p>';
    return;
  }

  const list = sel.type === 'region' ? state.annotations.regions : state.annotations.pins;
  const annotation = list.find(a => a.id === sel.id);
  if (!annotation) { clearSelection(); return; }

  renderDetailTree(sel.type === 'region' ? annotation : null);

  if (state.mode === 'design') {
    renderDetailEditor(annotation, sel.type);
  } else {
    renderDetailView(annotation);
  }
}

function renderMergePreview(source, target) {
  const bodyHtml = target.body
    ? (typeof marked !== 'undefined' ? marked.parse(target.body) : escapeHtml(target.body))
    : '<em style="color:#888">No description.</em>';
  detailContent.innerHTML = `
    <div class="merge-banner">
      Click to merge into
      <span class="color-wheel" style="background:${source.color || '#4a9eff'}"></span>
      <strong>${escapeHtml(source.label || 'Untitled')}</strong>
    </div>
    <h2 class="merge-target-title">
      <span class="color-wheel" style="background:${target.color || '#4a9eff'}"></span>
      ${escapeHtml(target.label || 'Untitled')}
    </h2>
    <div class="detail-body markdown-body">${bodyHtml}</div>
  `;
}

function backButtonHtml() {
  if (!navStack.length) return '';
  const prev = navStack[navStack.length - 1];
  const list = prev.type === 'region' ? state.annotations.regions : state.annotations.pins;
  const label = list.find(a => a.id === prev.id)?.label || 'Untitled';
  return `<button id="nav-back" class="btn-back">← ${escapeHtml(label)}</button>`;
}

function bindBackButton() {
  document.getElementById('nav-back')?.addEventListener('click', goBack);
}

function renderDetailView(annotation) {
  const bodyHtml = annotation.body
    ? (typeof marked !== 'undefined' ? marked.parse(annotation.body) : escapeHtml(annotation.body))
    : '<em style="color:#888">No description.</em>';
  detailContent.innerHTML = `
    ${backButtonHtml()}
    <h2 class="detail-title">${escapeHtml(annotation.label || 'Untitled')}</h2>
    <hr class="detail-divider" />
    <div class="detail-body markdown-body">${bodyHtml}</div>
  `;
  bindBackButton();
}

function renderDetailEditor(annotation, type) {
  const isRegion = type === 'region';

  const colorSwatch = isRegion ? `
    <details class="swatch-details">
      <summary class="swatch-summary">
        <span class="field-label" style="display:inline">Color</span>
        <span class="color-dot" style="background:${annotation.color || '#4a9eff'}"></span>
      </summary>
      ${renderSwatchGrid(annotation.color)}
    </details>` : '';

  const mergeBanner = (isRegion && state.ui.mergeSource === annotation.id)
    ? `<div class="merge-banner">
         Click another region to merge into this one.
         <button id="edit-merge-cancel" class="btn-link">Cancel</button>
       </div>`
    : '';

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

function renderTreeHtml(region) {
  const allPins = pinsInRegion(region);
  const pins = state.mode === 'display' ? allPins.filter(p => !p.hidden) : allPins;
  if (!pins.length) return '';
  const items = pins.map(p => `
    <div class="pin-list-item" data-pin-id="${p.id}">
      ${escapeHtml(p.label || 'Untitled pin')}
    </div>`).join('');
  return `
    <details class="pin-list" open>
      <summary class="pin-list-summary">Pins (${pins.length})</summary>
      ${items}
    </details>`;
}

function renderDetailTree(region) {
  if (!detailTree) return;
  const html = region ? renderTreeHtml(region) : '';
  if (html) {
    detailTree.innerHTML = html;
    detailTree.classList.remove('hidden');
    detailTree.querySelectorAll('[data-pin-id]').forEach(el => {
      el.addEventListener('click', () => {
        const pin = state.annotations.pins.find(p => p.id === el.dataset.pinId);
        if (!pin) return;
        navigateAnnotation('pin', pin.id);
        map.panTo(pin.latlng);
      });
    });
  } else {
    detailTree.innerHTML = '';
    detailTree.classList.add('hidden');
  }
}

// MAP CLICKING

map.on('click', (e) => {
  if (state.mode !== 'design') return;
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

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  if (e.key !== 'Escape') return;
  if (draw.active)            cancelRegionDraw();
  if (state.ui.mergeSource)   cancelMerge();
  if (vertexEdit.active)      exitVertexEdit();
  if (state.ui.activeTool === 'edit') setActiveTool(null);
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
      handle.on('dragend', () => { scheduleSave(); });
      handle.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (ring.length <= 3) return;
        pushHistory();
        region.polygons[ringIdx].splice(ptIdx, 1);
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

function applyBrush(latlng) {
  if (typeof polygonClipping === 'undefined') return;

  const r          = screenToBrushRadius();
  const circlePts  = circlePoly(latlng, r);
  const circleGeom = [circlePts.map(p => [p.lng, p.lat])];

  let region = null;
  let isNew  = false;
  if (state.ui.selected?.type === 'region') {
    region = state.annotations.regions.find(r2 => r2.id === state.ui.selected.id);
  }
  if (!region) {
    region = {
      id:       generateId(),
      polygons: [],
      color:    nextColor(),
      label:    'New Region',
      body:     '',
      hidden:   false,
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
      layers.regions[region.id]?.remove();
      delete layers.regions[region.id];
      if (state.ui.selected?.id === region.id) clearSelection();
      scheduleSave();
      return;
    }

    region.polygons = result.map(comp => comp[0].map(([lng, lat]) => ({ lat, lng })));
    remountRegionLayer(region);
    scheduleSave();
  });
}

map.on('mousedown', (e) => {
  if (state.mode !== 'design') return;
  const tool = state.ui.activeTool;
  if (tool !== 'brush' && tool !== 'eraser') return;
  brushPainting   = true;
  brushLastLatLng = e.latlng;
  pushHistory();
  if (tool === 'brush')  applyBrush(e.latlng);
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

map.on('mouseup',  () => { brushPainting = false; brushLastLatLng = null; });
map.on('mouseout', () => { brushPainting = false; brushLastLatLng = null; });

// INIT

initWorker();
const hadStored = loadAnnotations();
if (hadStored) {
  colorIndex = state.annotations.regions.length;
  flags.restoredAwaitingImage = true;
  updatePlaceholder();
}
setMode('display');
if (typeof lucide !== 'undefined') lucide.createIcons();
