// SELECTION — what is selected, back/up navigation, and following it to its layer

import { layers, navStack, state } from './state.js';
import { findAnnotation, parentInView } from './nesting.js';
import { map } from './map.js';
import { applyInteractivity, drillFocus, revealInView } from './render.js';
import { focusLabelOnce, renderDetailPanel } from './panel.js';
import { renderLayerStrip } from './layerstrip.js';

// switch to an item's layer without dropping selection (panel / back navigation)
export function followToLayer(type, id) {
  const item = findAnnotation(type, id);
  if (!item) return;
  if (state.mode === 'design') revealInView(item);
  showLayer(item.layerId);
}

// restyles even when the layer is unchanged: the display drill-down depends on the selection
export function showLayer(layerId) {
  if (layerId !== state.ui.activeLayerId) {
    state.ui.activeLayerId = layerId;
    if (state.ui.mergeSource) state.ui.mergeSource = null;
    renderLayerStrip();
  }
  applyInteractivity();
}

// SELECTION / NAVIGATION

// selection is set before following so the restyle sees it
export function selectAnnotation(type, id) {
  navStack.length = 0;
  state.ui.picked   = [];
  state.ui.selected = { type, id };
  followToLayer(type, id);
  renderDetailPanel();
  followCamera();
}

// a just-created item opens with its label focused, ready to name it
export function selectNew(type, id) {
  focusLabelOnce(id);
  selectAnnotation(type, id);
}

export function navigateAnnotation(type, id) {
  if (state.ui.selected) navStack.push({ ...state.ui.selected });
  state.ui.picked   = [];
  state.ui.selected = { type, id };
  followToLayer(type, id);
  renderDetailPanel();
  followCamera();
}

export function goBack() {
  if (!navStack.length) { if (state.mode === 'display') goUp(); else clearSelection(); return; }
  state.ui.selected = navStack.pop();
  followToLayer(state.ui.selected.type, state.ui.selected.id);
  renderDetailPanel();
  followCamera();
}

export function clearSelection() {
  navStack.length = 0;
  state.ui.selected = null;
  state.ui.picked   = [];
  applyInteractivity();
  renderDetailPanel();
  followCamera();
}

// MULTI-SELECTION — in Design Mode, shift-click (or a shift-drag box, select all, or the list's
// tick-boxes) gathers several items on the layer for changes made to all of them at once. They're
// state.ui.picked. On the map, gathering down to one is an ordinary selection; ticked in the list,
// one stays ticked, so the list stays open to tick more

export const isPicked     = (id) => state.ui.selected?.id === id || state.ui.picked.some(p => p.id === id);
export const hasSelection = () => !!state.ui.selected || state.ui.picked.length > 0;
export const selectionItems = () => state.ui.picked.length ? state.ui.picked
                                  : state.ui.selected ? [state.ui.selected] : [];

export function setPicked(items, { keep = false } = {}) {
  if (!items.length) { clearSelection(); return; }
  if (items.length === 1 && !keep) { selectAnnotation(items[0].type, items[0].id); return; }
  navStack.length   = 0;
  state.ui.selected = null;
  state.ui.picked   = items.map(({ type, id }) => ({ type, id }));
  applyInteractivity();
  renderDetailPanel();
}

// shift-click or a tick: in if it's out, out if it's in
export function togglePicked(type, id, { keep = false } = {}) {
  const items = selectionItems();
  setPicked(items.some(p => p.id === id) ? items.filter(p => p.id !== id) : [...items, { type, id }], { keep });
}

// a shift-drag box adds to what's gathered; select all replaces it
export function pickMany(items, { add = false } = {}) {
  const base = add ? selectionItems() : [];
  setPicked([...base, ...items.filter(it => !base.some(p => p.id === it.id))]);
}

// display mode: climb one level of the tree; above the root, browse the root's layer
export function goUp() {
  const sel    = state.ui.selected;
  const parent = sel && parentInView(findAnnotation(sel.type, sel.id));
  if (parent) selectAnnotation('region', parent.id);
  else clearSelection();
}

// CAMERA — in Display Mode the map follows every move through the tree: it glides to frame the place
// you're in (a region you open, or the region around a place with nothing inside it, so its
// neighbours stay in reach), and back out to the whole map when you leave. Design Mode moves only
// for the panel's links, and only to bring a place into view

const calm    = window.matchMedia('(prefers-reduced-motion: reduce)');
const FRAME   = 40;  // px kept clear around a framed place
const TOP     = 52;  // and under the layer tabs

function glideTo(bounds) {
  const flap = document.body.classList.contains('flap-open') && innerWidth > 640
    ? document.getElementById('tool-flap').offsetWidth : 0;
  const opts = { paddingTopLeft: [FRAME + flap, FRAME + TOP], paddingBottomRight: [FRAME, FRAME], maxZoom: map.getMaxZoom() };
  if (calm.matches) map.fitBounds(bounds, opts);
  else map.flyToBounds(bounds, { ...opts, duration: 0.8 });
}

// a place at the top with nothing inside it keeps the zoom, and only comes into view
function bringIntoView(item) {
  const bounds = item.polygons ? layers.regions[item.id]?.getBounds() : null;
  if (bounds?.isValid()) { if (!map.getBounds().contains(bounds)) map.panTo(bounds.getCenter(), { animate: !calm.matches }); }
  else if (item.latlng && !map.getBounds().contains(item.latlng)) map.panTo(item.latlng, { animate: !calm.matches });
}

export function followCamera() {
  if (state.mode !== 'display' || !state.image) return;
  const sel   = state.ui.selected;
  const item  = sel && findAnnotation(sel.type, sel.id);
  const focus = drillFocus();
  const room  = focus && layers.regions[focus.id]?.getBounds();
  if (room?.isValid()) glideTo(room);
  else if (item) bringIntoView(item);
  else glideTo(L.latLngBounds([[0, 0], [-state.image.height, state.image.width]]));
}

// the panel's links: Display Mode's camera has already moved with the selection
export function panToItem(type, id) {
  const item = findAnnotation(type, id);
  if (!item || state.mode === 'display') return;
  const bounds = item.polygons ? layers.regions[id]?.getBounds() : null;
  if (bounds?.isValid()) { if (!map.getBounds().contains(bounds)) glideTo(bounds); }
  else if (item.latlng && !map.getBounds().contains(item.latlng)) map.panTo(item.latlng, { animate: !calm.matches });
}
