// SHAPES — editing region geometry: merge, consolidate, vertex edit, brush and eraser

import { layers, state } from './state.js';
import { circlePoly, generateId, inflatePolygon, latlngDist, MERGE_BUFFER_PX, ringToGeom } from './utils.js';
import { scheduleSave } from './persistence.js';
import { orphanChildrenOf, renestAround } from './nesting.js';
import { map } from './map.js';
import { pushHistory } from './history.js';
import { clearSelection, selectAnnotation } from './selection.js';
import { remountRegionLayer, unmountRegion } from './render.js';
import { refreshLayerList, refreshTree, renderDetailPanel } from './panel.js';
import { nextColor } from './create.js';
import { setWandStatus } from './wand.js';

// DOM

const brushSizeInput   = document.getElementById('brush-size');
const brushSizeVal     = document.getElementById('brush-size-val');

// BRUSH STATE

let brushSizePx      = 30;
export const vertexEdit     = { active: false, regionId: null, handles: [], midHandles: [] };
let brushCursorLayer = null;
let brushPainting    = false;
let brushLastLatLng  = null;

brushSizeInput?.addEventListener('input', () => {
  brushSizePx = parseInt(brushSizeInput.value, 10);
  if (brushSizeVal) brushSizeVal.textContent = brushSizePx;
});

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

export function startMerge(regionId) {
  state.ui.mergeSource = regionId;
  renderDetailPanel();
}

export function cancelMerge() {
  if (!state.ui.mergeSource) return;
  state.ui.mergeSource = null;
  renderDetailPanel();
}

export function performMerge(targetId, sourceId) {
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
export function consolidateRegion(regionId) {
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

export function enterVertexEdit(regionId) {
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

export function exitVertexEdit() {
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

export function hideBrushCursor() {
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
