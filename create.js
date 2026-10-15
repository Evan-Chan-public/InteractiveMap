// CREATE — new pins and regions (drawn by hand), colours, and deletion

import { layers, state } from './state.js';
import { DEFAULT_MARK, generateId, PIGMENTS } from './utils.js';
import { scheduleSave } from './persistence.js';
import { orphanChildrenOf, renestAround } from './nesting.js';
import { map } from './map.js';
import { pushHistory } from './history.js';
import { clearSelection, selectNew } from './selection.js';
import { mountPinLayer, mountRegionLayer, unmountRegion } from './render.js';
import { showDeleteArmed } from './panel.js';

// PINS

export function addPin(latlng) {
  pushHistory();
  const pin = {
    id:      generateId(),
    latlng:  { lat: latlng.lat, lng: latlng.lng },
    label:   'New Pin',
    body:    '',
    hidden:  false,
    layerId: state.ui.activeLayerId,
    mark:    DEFAULT_MARK,
  };
  state.annotations.pins.push(pin);
  renestAround(pin);
  mountPinLayer(pin);
  selectNew('pin', pin.id);
  scheduleSave();
}

// REGIONS

export const draw = {
  active:   false,
  points:   [],
  markers:  [],
  polyline: null,
};

const REGION_COLORS = PIGMENTS.map(p => p.color);
let colorIndex = 0;
function nextColor() {
  return REGION_COLORS[colorIndex++ % REGION_COLORS.length];
}

// a new region on the active layer; callers add it to the annotations
export function newRegion(polygons) {
  return {
    id:       generateId(),
    polygons,
    color:    nextColor(),
    label:    'New Region',
    body:     '',
    hidden:   false,
    layerId:  state.ui.activeLayerId,
  };
}

// loaded maps continue the colour cycle where their regions left off
export function seedColors(count) {
  colorIndex = count;
}

const CLOSE_PX = 10; // click within this of the first vertex to close the shape

export function startRegionDraw(latlng) {
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
    radius: 4, weight: 1.5, fillOpacity: 1, interactive: false, className: 'draw-vertex',
  }).addTo(map);
  draw.markers.push(dot);

  if (draw.polyline) draw.polyline.remove();
  if (draw.points.length > 1) {
    draw.polyline = L.polyline(draw.points, {
      weight: 1.5, dashArray: '4 4', interactive: false, className: 'draw-line',
    }).addTo(map);
  }
}

export function commitRegion() {
  if (draw.points.length < 3) { cancelRegionDraw(); return; }
  pushHistory();
  const region = newRegion([draw.points.map(p => ({ lat: p.lat, lng: p.lng }))]);
  state.annotations.regions.push(region);
  renestAround(region);
  cancelRegionDraw();
  mountRegionLayer(region);
  selectNew('region', region.id);
  scheduleSave();
}

export function cancelRegionDraw() {
  draw.active = false;
  draw.points  = [];
  draw.markers.forEach(m => m.remove());
  draw.markers = [];
  if (draw.polyline) { draw.polyline.remove(); draw.polyline = null; }
}

// DELETION

// with confirmation on, the first Backspace / Delete click arms the button and a second one within
// a few seconds deletes. the setting is a per-browser preference (left panel), on by default
const CONFIRM_KEY = 'interactiveMap.confirmDeletes';
const ARM_MS      = 3000;
const confirmBox  = document.getElementById('confirm-deletes');

let confirmDeletes = true;
try { confirmDeletes = localStorage.getItem(CONFIRM_KEY) !== 'false'; } catch {}
if (confirmBox) confirmBox.checked = confirmDeletes;
confirmBox?.addEventListener('change', () => {
  confirmDeletes = confirmBox.checked;
  try { localStorage.setItem(CONFIRM_KEY, String(confirmDeletes)); } catch {}
  disarmDelete();
});

let armed = null; // { key, timer }

// items: [{ type, id }], one or a multi-selection; armed for that same set
const keyOf = (items) => items.map(it => it.id).join(' ');

export const isDeleteArmed = (items) => !!armed && (items === undefined || armed.key === keyOf(items));

export function requestDelete(items) {
  const key = keyOf(items);
  if (!confirmDeletes || armed?.key === key) {
    disarmDelete();
    deleteAnnotations(items);
    return;
  }
  disarmDelete();
  armed = { key, timer: setTimeout(disarmDelete, ARM_MS) };
  showDeleteArmed(true);
}

export function disarmDelete() {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed = null;
  showDeleteArmed(false);
}

// one undo step, however many go
function deleteAnnotations(items) {
  pushHistory();
  const gone = new Set(items.map(it => it.id));
  state.annotations.pins = state.annotations.pins.filter(p => {
    if (!gone.has(p.id)) return true;
    layers.pins[p.id]?.remove();
    delete layers.pins[p.id];
    return false;
  });
  const regionIds = [];
  state.annotations.regions = state.annotations.regions.filter(r => {
    if (!gone.has(r.id)) return true;
    unmountRegion(r.id);
    regionIds.push(r.id);
    return false;
  });
  if (regionIds.length) orphanChildrenOf(regionIds);
  clearSelection();
  scheduleSave();
}
