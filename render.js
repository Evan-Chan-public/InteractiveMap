// RENDER — annotations on the map: mounting leaflet layers, stacking order, visibility, interactivity

import { layers, state } from './state.js';
import { escapeHtml, markSvg } from './utils.js';
import { childrenInView, countInView, findAnnotation, parentInView } from './nesting.js';
import { map } from './map.js';
import { clearSelection, selectAnnotation } from './selection.js';
import { refreshLayerList, renderDetailPanel } from './panel.js';
import { renderLayerStrip } from './layerstrip.js';
import { enterVertexEdit, performMerge } from './shapes.js';
import { regionNameShown, scheduleLabelLayout } from './labels.js';

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

// a region's outlines, one per ring (its bands of pigment are separate: washElements)
function itemElements(type, id) {
  if (type === 'pin') return [layers.pins[id]?.getElement()];
  return (layers.regions[id]?.rings ?? []).map(r => r.outline.getElement());
}

function washElements(id) {
  return (layers.regions[id]?.rings ?? []).map(r => r.wash.getElement());
}

function styleItem(type, item, ix) {
  const frame    = ix.focus?.id === item.id;
  const dim      = !frame && !ix.isLive(item);
  const selected = state.ui.selected?.id === item.id;
  const els      = type === 'pin' ? itemElements(type, item.id) : [...itemElements(type, item.id), ...washElements(item.id)];
  for (const el of els) {
    el?.classList.toggle('layer-dim', dim);
    el?.classList.toggle('drill-frame', frame);
    el?.classList.toggle('is-selected', selected);
  }
  if (type === 'pin') stylePinAccess(itemElements('pin', item.id)[0], item, dim, selected);
  else styleRegionAccess(itemElements('region', item.id), item, dim || frame, selected);
}

// regions are buttons too: the first ring of a live region is a tab stop named by the place
// (further rings would repeat it); faded ones and the drill-down frame can't be used
function styleRegionAccess(els, region, inert, selected) {
  els.forEach((el, i) => {
    if (!el) return;
    if (inert || i > 0) { el.removeAttribute('tabindex'); el.removeAttribute('role'); el.removeAttribute('aria-label'); }
    else {
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', region.label || 'Untitled region');
    }
    if (selected && !inert && i === 0) el.setAttribute('aria-current', 'true');
    else el.removeAttribute('aria-current');
  });
}

// pins are buttons named by their place (the lettered name may be hidden by labels.js); faded
// ones can't be used, so they leave the tab order
function stylePinAccess(el, pin, dim, selected) {
  if (!el) return;
  el.tabIndex = dim ? -1 : 0;
  el.setAttribute('aria-label', pin.label || 'Untitled');
  if (selected) el.setAttribute('aria-current', 'true');
  else el.removeAttribute('aria-current');
}

// a click on a pin, or Enter / Space on a focused one
function activatePin(pin) {
  if (!isLive(pin)) return false;
  selectAnnotation('pin', pin.id);
  return true;
}

function pinAtElement(el) {
  const icon = el?.closest?.('.place-mark');
  return icon ? state.annotations.pins.find(p => layers.pins[p.id]?.getElement() === icon) : null;
}

function regionAtElement(el) {
  if (el?.tagName?.toLowerCase() !== 'path') return null;
  return state.annotations.regions.find(r => itemElements('region', r.id).includes(el)) ?? null;
}

// Enter / Space on a focused pin or region does what a click does
// faded marks let clicks through to what's beneath, so hovering is found by position: the mark
// under a resting mouse pointer is named (one at a time)
let peeked = null;
export function peekFadedMark(x, y) {
  let hit = null;
  if (x !== null) {
    for (const pin of state.annotations.pins) {
      const el = layers.pins[pin.id]?.getElement();
      if (!el?.classList.contains('layer-dim')) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3) { hit = el; break; }
    }
  }
  if (hit === peeked) return;
  peeked?.classList.remove('is-peeked');
  hit?.classList.add('is-peeked');
  peeked = hit;
}

export function activateMapElement(el) {
  const pin = pinAtElement(el);
  if (pin) return activatePin(pin);
  const region = regionAtElement(el);
  return region ? activateRegion(region) : false;
}

// a region reached by keyboard shows its name, as hovering does
export function regionFocusChanged(el, focused) {
  const region = regionAtElement(el);
  if (!region) return null;
  layers.regions[region.id]?.rings.forEach(({ outline: poly }) => {
    if (poly.getElement() !== el) return;
    if (!focused) { poly.closeTooltip(); return; }
    const center = poly.getBounds().getCenter();
    if (!map.getBounds().contains(center)) map.panTo(center);
    poly.openTooltip(center);
  });
  return region;
}

// a click on a region, or Enter / Space on a focused one
function activateRegion(region) {
  // creation tools and faded items pass the click through to the map
  if (['pin', 'region', 'wand'].includes(state.ui.activeTool)) return false;
  if (!isLive(region)) return false;
  if (state.ui.mergeSource && state.ui.mergeSource !== region.id) {
    performMerge(state.ui.mergeSource, region.id);
    return true;
  }
  selectAnnotation('region', region.id);
  if (state.ui.activeTool === 'edit') enterVertexEdit(region.id);
  return true;
}

export function applyInteractivity() {
  const ix = interactivity();
  state.annotations.regions.forEach(r => styleItem('region', r, ix));
  state.annotations.pins.forEach(p => styleItem('pin', p, ix));
  updateVeil(ix.focus);
  scheduleLabelLayout(); // which names show depends on the active layer, drill-down and selection
}

// DRILL VEIL — drilled into a region, everything outside it is veiled in the ground colour, so the
// place you're in stands clear. One polygon: the whole plane with the region's rings cut out
let veil = null;

function updateVeil(focus) {
  const group = focus && layers.regions[focus.id];
  if (!group || !map.hasLayer(group)) { veil?.remove(); veil = null; return; }
  const far   = 1e6;
  const plane = [[-far, -far], [-far, far], [far, far], [far, -far]];
  const rings = [plane, ...focus.polygons.map(ring => ring.map(p => [p.lat, p.lng]))];
  if (veil) veil.setLatLngs(rings);
  else veil = L.polygon(rings, { pane: 'drillVeil', interactive: false, stroke: false, className: 'drill-veil' }).addTo(map);
}

// a pin is lettered onto the map like a place on an old map: an inked mark with its name beside it.
// The icon is the mark; the name hangs off it on whichever side labels.js finds free
const pinIcon = (pin) => L.divIcon({
  className:  'place-mark label-right',
  iconSize:   [14, 14],
  iconAnchor: [7, 7],
  html:       `${markSvg(pin.mark)}<span class="place-label">${escapeHtml(pin.label || 'Untitled')}</span>`,
});

export function mountPinLayer(pin, single = true) {
  const marker = L.marker([pin.latlng.lat, pin.latlng.lng], { icon: pinIcon(pin), riseOnHover: true }).addTo(map);
  marker.on('click', (e) => {
    if (activatePin(pin)) L.DomEvent.stopPropagation(e);
  });
  layers.pins[pin.id] = marker;
  if (single) { styleItem('pin', pin, interactivity()); scheduleLabelLayout(); }
}

// label or mark changed: the icon is rebuilt, so it's restyled too
export function updatePinLayer(pin) {
  const marker = layers.pins[pin.id];
  if (!marker) return;
  marker.setIcon(pinIcon(pin));
  styleItem('pin', pin, interactivity());
  scheduleLabelLayout();
}

// A region is drawn as an old-map colourist tinted one: a thin inked edge and a faint wash inside
// (the outline, which takes the clicks), and a band of pigment painted along the inside of the
// boundary (a wide stroke in its own pane, clipped to the outline's shape so it never spills over
// a neighbour). Colours come from CSS through --pigment, so states are styled there
const SVG_NS = 'http://www.w3.org/2000/svg';
let ringSeq = 0;

function paintRing(outline, wash) {
  const id = `region-ring-${++ringSeq}`;
  outline.on('add', () => {
    const el = outline.getElement();
    el.id = id;
    el.classList.add('region-outline');
    el.style.setProperty('--pigment', outline.options.fillColor);
  });
  wash.on('add', () => {
    const el  = wash.getElement();
    const svg = el.ownerSVGElement;
    let clip  = svg.querySelector(`#${id}-clip`);
    if (!clip) {
      const defs = svg.querySelector('defs') ?? svg.insertBefore(document.createElementNS(SVG_NS, 'defs'), svg.firstChild);
      clip = document.createElementNS(SVG_NS, 'clipPath');
      clip.id = `${id}-clip`;
      const use = document.createElementNS(SVG_NS, 'use');
      use.setAttribute('href', `#${id}`);
      clip.appendChild(use);
      defs.appendChild(clip);
    }
    el.setAttribute('clip-path', `url(#${id}-clip)`);
    el.classList.add('region-wash');
    el.style.setProperty('--pigment', wash.options.color);
  });
  return id;
}

function ringLayers(ring, color) {
  const latlngs = ring.map(p => [p.lat, p.lng]);
  const outline = L.polygon(latlngs, { color, weight: 1, fillColor: color, fillOpacity: 0.07 });
  const wash    = L.polygon(latlngs, { pane: 'regionWash', color, weight: 12, opacity: 0.5, fill: false, interactive: false });
  const id      = paintRing(outline, wash);
  return { outline, wash, id };
}

export function mountRegionLayer(region, single = true) {
  const group = L.featureGroup().addTo(map);
  group.rings = [];

  for (const ring of region.polygons) {
    const r = ringLayers(ring, region.color);
    r.outline.bindTooltip(escapeHtml(region.label || 'Region'), { sticky: true, className: 'region-tip' });
    r.outline.on('tooltipopen', (e) => {
      // a region whose name is lettered on the map needs no slip
      e.tooltip.getElement()?.classList.toggle('is-redundant', regionNameShown(region.id));
    });
    group.addLayer(r.wash);
    group.addLayer(r.outline);
    group.rings.push(r);
  }

  group.on('click', (e) => {
    if (activateRegion(region)) L.DomEvent.stopPropagation(e);
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

// the band's clip lives in the wash pane's <defs>; it goes with its region
function dropClips(group) {
  group?.rings?.forEach(r => document.getElementById(`${r.id}-clip`)?.remove());
}

export function unmountAll() {
  Object.values(layers.pins).forEach(m => m.remove());
  Object.values(layers.regions).forEach(g => { g.remove(); dropClips(g); });
  layers.pins    = {};
  layers.regions = {};
}

export function unmountRegion(id) {
  dropClips(layers.regions[id]);
  layers.regions[id]?.remove();
  delete layers.regions[id];
  scheduleLabelLayout(); // its name goes with it
}

export function updateRegionLayer(region) {
  const group = layers.regions[region.id];
  if (!group) return;
  for (const { outline, wash } of group.rings) {
    outline.setTooltipContent(escapeHtml(region.label || 'Region'));
    outline.setStyle({ color: region.color, fillColor: region.color });
    wash.setStyle({ color: region.color });
    outline.getElement()?.style.setProperty('--pigment', region.color);
    wash.getElement()?.style.setProperty('--pigment', region.color);
  }
  scheduleLabelLayout(); // the name may have changed
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
