// RENDER — annotations on the map: mounting leaflet layers, stacking order, visibility, interactivity

import { layers, state } from './state.js';
import { escapeHtml } from './utils.js';
import { childrenInView, countInView, findAnnotation, parentInView } from './nesting.js';
import { map } from './map.js';
import { clearSelection, selectAnnotation } from './selection.js';
import { refreshLayerList, renderDetailPanel } from './panel.js';
import { renderLayerStrip } from './layerstrip.js';
import { enterVertexEdit, performMerge } from './shapes.js';

export function applyZOrder() {
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

// INTERACTIVITY — what's clickable, faded, or framing the drill-down
//
// design: the active layer. display: the children of the region drilled into (on any layer);
// with nothing drilled into, the active layer. layer order only decides what draws on top.

// display mode's drill-down region: the selection if it has children, else the selection's parent
export function drillFocus() {
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

export function applyInteractivity() {
  const ix = interactivity();
  state.annotations.regions.forEach(r => styleItem('region', r, ix));
  state.annotations.pins.forEach(p => styleItem('pin', p, ix));
}

export function mountPinLayer(pin, single = true) {
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

export function updatePinLayer(pin) {
  const marker = layers.pins[pin.id];
  if (!marker) return;
  marker.setTooltipContent(escapeHtml(pin.label || 'Pin'));
}

export function mountRegionLayer(region, single = true) {
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
export function mountAll() {
  state.annotations.pins.forEach(p => mountPinLayer(p, false));
  state.annotations.regions.forEach(r => mountRegionLayer(r, false));
  applyLayerVisibility();
  applyZOrder();
}

export function unmountAll() {
  Object.values(layers.pins).forEach(m => m.remove());
  Object.values(layers.regions).forEach(g => g.remove());
  layers.pins    = {};
  layers.regions = {};
}

export function unmountRegion(id) {
  layers.regions[id]?.remove();
  delete layers.regions[id];
}

export function updateRegionLayer(region) {
  const group = layers.regions[region.id];
  if (!group) return;
  group.eachLayer(poly => {
    poly.setTooltipContent(escapeHtml(region.label || 'Region'));
    poly.setStyle({ color: region.color, fillColor: region.color });
  });
}

export function remountRegionLayer(region) {
  unmountRegion(region.id);
  mountRegionLayer(region);
}

// Display Mode honours each item's "hidden" flag; Design Mode honours the eye toggles instead
const offMap = (item) => state.mode === 'display' ? item.hidden : hiddenInView(item);

export function applyLayerVisibility() {
  let readded = false;
  const show = (leafletLayer, item) => {
    if (offMap(item)) { leafletLayer.remove(); return; }
    if (!map.hasLayer(leafletLayer)) { leafletLayer.addTo(map); readded = true; }
  };
  state.annotations.pins.forEach(pin => { if (layers.pins[pin.id]) show(layers.pins[pin.id], pin); });
  state.annotations.regions.forEach(region => { if (layers.regions[region.id]) show(layers.regions[region.id], region); });
  if (readded) applyZOrder(); // a re-added region lands on top of everything
  applyInteractivity();
}

// EYE TOGGLES — declutter the view while editing. View-only: never saved, not in undo history,
// and ignored in Display Mode

export function hiddenInView(item) {
  return state.ui.viewHidden.has(item.id) || state.ui.viewHiddenLayers.has(item.layerId);
}

export function toggleItemView(id) {
  const set = state.ui.viewHidden;
  if (set.has(id)) set.delete(id); else set.add(id);
  afterViewChange();
}

export function toggleLayerView(layerId) {
  const set = state.ui.viewHiddenLayers;
  if (set.has(layerId)) set.delete(layerId); else set.add(layerId);
  afterViewChange();
}

// an item you select or create becomes visible again (with its layer)
export function revealInView(item) {
  if (!item || !hiddenInView(item)) return false;
  state.ui.viewHidden.delete(item.id);
  state.ui.viewHiddenLayers.delete(item.layerId);
  afterViewChange();
  return true;
}

export function clearViewHiding() {
  state.ui.viewHidden.clear();
  state.ui.viewHiddenLayers.clear();
}

function afterViewChange() {
  const sel = state.ui.selected;
  if (sel && state.mode === 'design' && hiddenInView(findAnnotation(sel.type, sel.id) ?? {})) clearSelection();
  applyLayerVisibility();
  renderLayerStrip();
  refreshLayerList();
}
