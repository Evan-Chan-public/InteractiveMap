// CREATE — new pins and regions (drawn by hand), colours, and deletion

import { layers, state } from './state.js';
import { DEFAULT_MARK, generateId } from './utils.js';
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

const REGION_COLORS = [
  '#4a9eff', '#ff7c4a', '#4aff9e', '#ff4a7c',
  '#c04aff', '#ffe04a', '#4afff0', '#ff4adf',
];
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

let armed = null; // { id, timer }

export const isDeleteArmed = (id) => !!armed && (id === undefined || armed.id === id);

export function requestDelete(type, id) {
  if (!confirmDeletes || armed?.id === id) {
    disarmDelete();
    deleteAnnotation(type, id);
    return;
  }
  disarmDelete();
  armed = { id, timer: setTimeout(disarmDelete, ARM_MS) };
  showDeleteArmed(true);
}

export function disarmDelete() {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed = null;
  showDeleteArmed(false);
}

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
