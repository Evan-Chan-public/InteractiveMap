const state = {
  mode: 'display',       // 'display' | 'design'
  image: null,           // { url, width, height }
  annotations: {
    regions: [],         // [{ id, points, color, label, body }]
    pins: [],            // [{ id, latlng, label, body }]
  },
  ui: {
    activeTool: null,    // 'region' | 'pin' | null
    selected: null,      // { type: 'region'|'pin', id }
    filter: null,        // future: { regionId }
    mergeSource: null,   // region id, for picking merge region
    mergeHover:  null,   // region id, for hovered candidate
  },
};

// Leaflet!
const layers = {
  pins: {},    // id → L.Marker
  regions: {}, // id → L.Polygon
};

// PERSISTENCE
// Annotations are saved to localStorage
// Image is reloaded manually

const STORAGE_KEY = 'interactiveMap.annotations.v1';
let restoredAwaitingImage = false; 

function saveAnnotations() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.annotations));
  } catch (err) {
    console.warn('Could not save annotations:', err);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAnnotations, 300);
}

function loadAnnotations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (Array.isArray(data?.regions)) state.annotations.regions = data.regions;
    if (Array.isArray(data?.pins))    state.annotations.pins    = data.pins;
    return state.annotations.regions.length > 0 || state.annotations.pins.length > 0;
  } catch (err) {
    console.warn('Could not load annotations:', err);
    return false;
  }
}

function clearSavedAnnotations() {
  state.annotations.regions = [];
  state.annotations.pins = [];
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  restoredAwaitingImage = false;
}

function mountAllAnnotations() {
  state.annotations.pins.forEach(mountPinLayer);
  state.annotations.regions.forEach(mountRegionLayer);
}

function updatePlaceholder() {
  const ph = document.getElementById('map-placeholder');
  if (!ph) return;
  if (state.image) { ph.classList.add('hidden'); return; }
  ph.classList.remove('hidden');

  if (restoredAwaitingImage) {
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

// WASM Worker

const WINDOW = 1024; // window size (native px)

let worker = null;
let workerReady = false;
let wandPending = false; // true while a fill is in flight
let wandOffset  = { x: 0, y: 0 }; // top-left of window in native coords
let wandStage   = '';
let wandStart   = 0;     // performance.now() at trigger time
let wandTicker  = null;  // setInterval handle for elapsed-time updater

function initWorker() {
  worker = new Worker('./worker.js');
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      workerReady = true;
    } else if (msg.type === 'progress') {
      wandStage = msg.stage;
      updateWandTicker(msg);
    } else if (msg.type === 'result') {
      stopWandTicker();
      onWandResult(msg);
    } else if (msg.type === 'empty') {
      stopWandTicker();
      wandPending = false;
      setWandStatus('No fill — try adjusting tolerance or clicking a different spot.');
    } else if (msg.type === 'error') {
      stopWandTicker();
      wandPending = false;
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
  if (msg?.filled    != null) extra += ` · ${msg.filled.toLocaleString()} px`;
  if (msg?.rawCount  != null) extra += ` · ${msg.rawCount.toLocaleString()} corners`;
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

// Preserves reference to the original Image for windows

let sourceImage = null;

// MAP SETUP

const map = L.map('map', {
  crs: L.CRS.Simple,
  minZoom: -4,
  maxZoom: 4,
  zoomSnap: 0,
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 40, // lower = scroll-wheel zooms further per tick
  attributionControl: false,
});

let imageOverlay = null;
let mapBounds    = null;

// DOM

const toolsPanel     = document.getElementById('tools-panel');
const detailPanel    = document.getElementById('detail-panel');
const detailContent  = document.getElementById('detail-content');
const mapPlaceholder = document.getElementById('map-placeholder');
const btnMode        = document.getElementById('btn-mode');
const btnUpload      = document.getElementById('tool-upload');
const uploadInput    = document.getElementById('upload-input');
const btnRegion      = document.getElementById('tool-region');
const btnPin         = document.getElementById('tool-pin');
const btnWand           = document.getElementById('tool-wand');
const wandStatus        = document.getElementById('wand-status');
const wandTolerance     = document.getElementById('wand-tolerance');
const wandToleranceVal  = document.getElementById('wand-tolerance-val');
const btnWandCancel     = document.getElementById('wand-cancel');

wandTolerance?.addEventListener('input', () => {
  if (wandToleranceVal) wandToleranceVal.textContent = wandTolerance.value;
});

btnWandCancel?.addEventListener('click', cancelWand);

// MODE
  if (mode === 'design') {
    toolsPanel.classList.remove('hidden');
    btnMode.textContent = 'Switch to Display Mode';
  } else {
    toolsPanel.classList.add('hidden');
    btnMode.textContent = 'Switch to Design Mode';
    setActiveTool(null);
    cancelRegionDraw();
  }
  renderDetailPanel();
}

btnMode.addEventListener('click', () => {
  setMode(state.mode === 'design' ? 'display' : 'design');
});

// TOOLS

function setActiveTool(tool) {
  state.ui.activeTool = tool;
  [btnRegion, btnPin, btnWand].forEach(b => b.classList.remove('active'));
  if (tool === 'region') btnRegion.classList.add('active');
  if (tool === 'pin')    btnPin.classList.add('active');
  if (tool === 'wand')   btnWand.classList.add('active');
  map.getContainer().style.cursor = tool ? 'crosshair' : '';
  if (tool !== 'region') cancelRegionDraw();
  if (tool !== 'wand')   setWandStatus('');
}

btnRegion.addEventListener('click', () => {
  setActiveTool(state.ui.activeTool === 'region' ? null : 'region');
});

btnPin.addEventListener('click', () => {
  setActiveTool(state.ui.activeTool === 'pin' ? null : 'pin');
});

btnWand.addEventListener('click', () => {
  setActiveTool(state.ui.activeTool === 'wand' ? null : 'wand');
});

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
    sourceImage = img; // keep reference for wand window extraction
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

  if (restoredAwaitingImage) {
    mountAllAnnotations();
    restoredAwaitingImage = false;
  }
}

// PINS

function addPin(latlng) {
  const pin = {
    id:     generateId(),
    latlng: { lat: latlng.lat, lng: latlng.lng },
    label:  'New Pin',
    body:   '',
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
  points:   [],   // L.LatLng[]
  markers:  [],   // temporary vertex markers
  polyline: null, // preview polyline
};

const REGION_COLORS = [
  '#4a9eff', '#ff7c4a', '#4aff9e', '#ff4a7c',
  '#c04aff', '#ffe04a', '#4afff0', '#ff4adf',
];
let colorIndex = 0;
function nextColor() {
  return REGION_COLORS[colorIndex++ % REGION_COLORS.length];
}

function startRegionDraw(latlng) {
  if (!draw.active) {
    draw.active = true;
    draw.points  = [];
    draw.markers = [];
  }
  draw.points.push(latlng);

  // Vertex dot
  const dot = L.circleMarker(latlng, {
    radius: 4, color: '#fff', weight: 1.5,
    fillColor: '#4a9eff', fillOpacity: 1, interactive: false,
  }).addTo(map);
  draw.markers.push(dot);

  // Rebuild polyline
  if (draw.polyline) draw.polyline.remove();
  if (draw.points.length > 1) {
    draw.polyline = L.polyline(draw.points, {
      color: '#4a9eff', weight: 1.5, dashArray: '4 4', interactive: false,
    }).addTo(map);
  }
}

function commitRegion() {
  if (draw.points.length < 3) {
    cancelRegionDraw();
    return;
  }

  const region = {
    id:     generateId(),
    points: draw.points.map(p => ({ lat: p.lat, lng: p.lng })),
    color:  nextColor(),
    label:  'New Region',
    body:   '',
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
  const latlngs = region.points.map(p => [p.lat, p.lng]);
  const poly = L.polygon(latlngs, {
    color:       region.color,
    weight:      1.5,
    fillColor:   region.color,
    fillOpacity: 0.18,
  }).addTo(map);

  poly.bindTooltip(region.label || 'Region', { sticky: true });

  poly.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    if (state.ui.mergeSource && state.ui.mergeSource !== region.id) {
      performMerge(state.ui.mergeSource, region.id);
      return;
    }
    selectAnnotation('region', region.id);
  });

  poly.on('mouseover', () => {
    if (state.ui.mergeSource && state.ui.mergeSource !== region.id) {
      state.ui.mergeHover = region.id;
      renderDetailPanel();
    }
  });

  poly.on('mouseout', () => {
    if (state.ui.mergeHover === region.id) {
      state.ui.mergeHover = null;
      renderDetailPanel();
    }
  });

  layers.regions[region.id] = poly;
}

function updateRegionLayer(region) {
  const poly = layers.regions[region.id];
  if (!poly) return;
  poly.setTooltipContent(region.label || 'Region');
  poly.setStyle({ color: region.color, fillColor: region.color });
}

// MERGE
// TODO: Uses polygon-clipping; correct path later for other usrs

function startMerge(targetId) {
  state.ui.mergeSource = targetId;
  renderDetailPanel();
}

function cancelMerge() {
  if (!state.ui.mergeSource) return;
  state.ui.mergeSource = null;
  renderDetailPanel();
}

// Buffer distance (in native pxs) used to bridge gaps from boundary lines.
// Bridge width = (2 * buffer − gap)
// Max = (2 * buffer)
// 1-4 px recommended, tweak this later for larger imgs
const MERGE_BUFFER_PX = 1;

function performMerge(targetId, sourceId) {
  const target = state.annotations.regions.find(r => r.id === targetId);
  const source = state.annotations.regions.find(r => r.id === sourceId);
  if (!target || !source) { cancelMerge(); return; }

  if (typeof polygonClipping === 'undefined') {
    console.error('polygon-clipping library not loaded');
    setWandStatus('Merge unavailable: polygon library failed to load.');
    cancelMerge();
    return;
  }

  // needed to convert to polygon-clipping format
  const toGeom = (pts) => [pts.map(p => [p.lng, p.lat])];
  const targetGeom = toGeom(target.points);
  const sourceGeom = toGeom(source.points);

  let bridge = [];
  try {
    const targetBuf = toGeom(inflatePolygon(target.points, MERGE_BUFFER_PX));
    const sourceBuf = toGeom(inflatePolygon(source.points, MERGE_BUFFER_PX));
    bridge = polygonClipping.intersection(targetBuf, sourceBuf);
  } catch (err) {
    console.warn('bridge computation failed; merging without bridge:', err);
    bridge = [];
  }

  let merged;
  try {
    merged = bridge.length
      ? polygonClipping.union(targetGeom, sourceGeom, bridge)
      : polygonClipping.union(targetGeom, sourceGeom);
  } catch (err) {
    console.error('polygonClipping.union threw:', err);
    setWandStatus('Merge failed: ' + (err.message || 'invalid geometry'));
    cancelMerge();
    return;
  }
  if (!merged?.length) {
    setWandStatus('Merge produced no result.');
    cancelMerge();
    return;
  }

  // Keep largest disconnected piece
  // TODO: Permit disconnected merges
  let best = merged[0][0];
  let bestArea = ringArea(best);
  for (let i = 1; i < merged.length; ++i) {
    const a = ringArea(merged[i][0]);
    if (a > bestArea) { best = merged[i][0]; bestArea = a; }
  }

  target.points = best.map(([lng, lat]) => ({ lat, lng }));

  // Drop src region
  state.annotations.regions = state.annotations.regions.filter(r => r.id !== sourceId);
  layers.regions[sourceId]?.remove();
  delete layers.regions[sourceId];

  // Remount new geometry
  layers.regions[targetId]?.remove();
  delete layers.regions[targetId];
  mountRegionLayer(target);

  state.ui.mergeSource = null;
  selectAnnotation('region', targetId);
  scheduleSave();
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a / 2);
}

// Offset every vertex outward
// Very approximate but it will do
// polygon-clipping can handle self overlap

function inflatePolygon(points, distance) {
  const n = points.length;
  if (n < 3) return points.slice();

  let signed = 0;
  for (let i = 0; i < n; ++i) {
    const a = points[i], b = points[(i + 1) % n];
    signed += a.lng * b.lat - b.lng * a.lat;
  }
  // CW (signed < 0) is usual case (trace runs CW in screen ->
  // CW in lat/lng since lat = −y).
  // Orient = -1 -> outward = (−edgeY, edgeX).
  const orient = signed > 0 ? 1 : -1;

  const result = new Array(n);
  for (let i = 0; i < n; ++i) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];

    const e1x = curr.lng - prev.lng, e1y = curr.lat - prev.lat;
    const e2x = next.lng - curr.lng, e2y = next.lat - curr.lat;

    const e1Len = Math.hypot(e1x, e1y);
    const e2Len = Math.hypot(e2x, e2y);
    if (e1Len < 1e-9 || e2Len < 1e-9) { result[i] = { ...curr }; continue; }

    const n1x = orient * e1y / e1Len, n1y = -orient * e1x / e1Len;
    const n2x = orient * e2y / e2Len, n2y = -orient * e2x / e2Len;

    let bx = n1x + n2x, by = n1y + n2y;
    const bLen = Math.hypot(bx, by);

    if (bLen < 1e-9) {
      result[i] = { lng: curr.lng + n1x * distance, lat: curr.lat + n1y * distance };
      continue;
    }
    bx /= bLen; by /= bLen;

    const cosHalf = n1x * bx + n1y * by;
    const factor = cosHalf > 0.05 ? distance / cosHalf : distance * 20;

    result[i] = { lng: curr.lng + bx * factor, lat: curr.lat + by * factor };
  }
  return result;
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

  // Window centred on click
  // maybe future centre window in selected box?
  const half = Math.floor(WINDOW / 2);
  const x0 = Math.max(0, Math.min(width  - WINDOW, nativeX - half));
  const y0 = Math.max(0, Math.min(height - WINDOW, nativeY - half));
  const ww = Math.min(WINDOW, width  - x0);
  const wh = Math.min(WINDOW, height - y0);

  const seedX = nativeX - x0;
  const seedY = nativeY - y0;
  if (seedX < 0 || seedX >= ww || seedY < 0 || seedY >= wh) return;

  // Extract window into temp canvas
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

  const region = {
    id:     generateId(),
    points: latlngs,
    color:  nextColor(),
    label:  'New Region',
    body:   '',
  };
  state.annotations.regions.push(region);
  mountRegionLayer(region);
  selectAnnotation('region', region.id);
  scheduleSave();
}

// DELETION

function deleteAnnotation(type, id) {
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

// SELECTION/DETAILS

function selectAnnotation(type, id) {
  state.ui.selected = { type, id };
  detailPanel.classList.remove('hidden');
  renderDetailPanel();
  // TODO: apply highlight style to selected layer
}

function clearSelection() {
  state.ui.selected = null;
  detailPanel.classList.add('hidden');
  renderDetailPanel();
}

function renderDetailPanel() {
  const sel = state.ui.selected;

  // Hover preview
  if (state.ui.mergeSource && state.ui.mergeHover
      && state.ui.mergeSource !== state.ui.mergeHover) {
    const source = state.annotations.regions.find(r => r.id === state.ui.mergeSource);
    const target = state.annotations.regions.find(r => r.id === state.ui.mergeHover);
    if (source && target) {
      renderMergePreview(source, target);
      return;
    }
  }

  if (!sel) {
    detailContent.innerHTML = '<p class="detail-empty">Click a region or pin to see details.</p>';
    return;
  }

  const list = sel.type === 'region'
    ? state.annotations.regions
    : state.annotations.pins;
  const annotation = list.find(a => a.id === sel.id);
  if (!annotation) { clearSelection(); return; }

  if (state.mode === 'design') {
    renderDetailEditor(annotation, sel.type);
  } else {
    renderDetailView(annotation);
  }
}

function renderMergePreview(source, target) {
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
    <div class="detail-body">${target.body || '<em style="color:#888">No description.</em>'}</div>
  `;
}

function renderDetailView(annotation) {
  detailContent.innerHTML = `
    <h2>${escapeHtml(annotation.label || 'Untitled')}</h2>
    <div class="detail-body">${annotation.body || '<em style="color:#888">No description.</em>'}</div>
  `;
}

function renderDetailEditor(annotation, type) {
  const colorSwatch = type === 'region'
    ? `<label class="field-label">Color</label>
       <input id="edit-color" type="color" class="field-color" value="${annotation.color || '#4a9eff'}" />`
    : '';

  const mergeBanner = (type === 'region' && state.ui.mergeSource === annotation.id)
    ? `<div class="merge-banner">
         Click another region to merge into this one.
         <button id="edit-merge-cancel" class="btn-link">Cancel</button>
       </div>`
    : '';

  const mergeBtn = type === 'region'
    ? `<button id="edit-merge" class="btn-secondary">Merge…</button>`
    : '';

  detailContent.innerHTML = `
    <div class="detail-editor">
      ${mergeBanner}

      <label class="field-label" for="edit-label">Label</label>
      <input id="edit-label" type="text" class="field-input"
             value="${escapeHtml(annotation.label || '')}" placeholder="Label…" />

      ${colorSwatch}

      <label class="field-label" for="edit-body">Description <span class="field-hint">(HTML ok)</span></label>
      <textarea id="edit-body" class="field-textarea"
                placeholder="Description…">${escapeHtml(annotation.body || '')}</textarea>

      <div class="editor-actions">
        ${mergeBtn}
        <button id="edit-delete" class="btn-danger">Delete</button>
      </div>
    </div>
  `;

  const labelInput = document.getElementById('edit-label');
  const bodyInput  = document.getElementById('edit-body');

  labelInput.addEventListener('input', () => {
    annotation.label = labelInput.value;
    if (type === 'pin')    updatePinLayer(annotation);
    if (type === 'region') updateRegionLayer(annotation);
    scheduleSave();
  });

  bodyInput.addEventListener('input', () => {
    annotation.body = bodyInput.value;
    scheduleSave();
  });

  if (type === 'region') {
    document.getElementById('edit-color').addEventListener('input', (e) => {
      annotation.color = e.target.value;
      updateRegionLayer(annotation);
      scheduleSave();
    });
  }

  document.getElementById('edit-delete').addEventListener('click', () => {
    deleteAnnotation(type, annotation.id);
  });

  document.getElementById('edit-merge')?.addEventListener('click', () => {
    startMerge(annotation.id);
  });

  document.getElementById('edit-merge-cancel')?.addEventListener('click', () => {
    cancelMerge();
  });

  labelInput.focus();
  labelInput.select();
}

// MAP CLICKING

map.on('click', (e) => {
  if (state.mode !== 'design') return;

  if (state.ui.activeTool === 'pin') {
    addPin(e.latlng);
  } else if (state.ui.activeTool === 'region') {
    startRegionDraw(e.latlng);
  } else if (state.ui.activeTool === 'wand') {
    triggerWand(e.latlng);
  } else {
    clearSelection();
  }
});

map.on('dblclick', (e) => {
  if (state.mode !== 'design') return;
  if (state.ui.activeTool === 'region') {
    L.DomEvent.stopPropagation(e);
    commitRegion();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (draw.active)          cancelRegionDraw();
  if (state.ui.mergeSource) cancelMerge();
});

// UTILS

function generateId() {
  return Math.random().toString(36).slice(2, 9);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// INIT
const hadStored = loadAnnotations();
if (hadStored) {
  colorIndex = state.annotations.regions.length;
  restoredAwaitingImage = true;
  updatePlaceholder();
}
setMode('display');
