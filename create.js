// CREATE — new pins and regions (drawn by hand), colours, and deletion

import { layers, state } from './state.js';
import { generateId } from './utils.js';
import { scheduleSave } from './persistence.js';
import { orphanChildrenOf, renestAround } from './nesting.js';
import { map } from './map.js';
import { pushHistory } from './history.js';
import { clearSelection, selectAnnotation } from './selection.js';
import { mountPinLayer, mountRegionLayer, unmountRegion } from './render.js';

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
  };
  state.annotations.pins.push(pin);
  renestAround(pin);
  mountPinLayer(pin);
  selectAnnotation('pin', pin.id);
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
export function nextColor() {
  return REGION_COLORS[colorIndex++ % REGION_COLORS.length];
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

export function cancelRegionDraw() {
  draw.active = false;
  draw.points  = [];
  draw.markers.forEach(m => m.remove());
  draw.markers = [];
  if (draw.polyline) { draw.polyline.remove(); draw.polyline = null; }
}

// DELETION

export function deleteAnnotation(type, id) {
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
