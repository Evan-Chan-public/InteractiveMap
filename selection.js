// SELECTION — what is selected, back/up navigation, and following it to its layer

import { layers, navStack, state } from './state.js';
import { findAnnotation, parentInView } from './nesting.js';
import { map } from './map.js';
import { applyInteractivity, revealInView } from './render.js';
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
}

export function goBack() {
  if (!navStack.length) { if (state.mode === 'display') goUp(); else clearSelection(); return; }
  state.ui.selected = navStack.pop();
  followToLayer(state.ui.selected.type, state.ui.selected.id);
  renderDetailPanel();
}

export function clearSelection() {
  navStack.length = 0;
  state.ui.selected = null;
  state.ui.picked   = [];
  applyInteractivity();
  renderDetailPanel();
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

export function panToItem(type, id) {
  const item = findAnnotation(type, id);
  if (type === 'pin' && item) map.panTo(item.latlng);
  if (type === 'region') {
    const bounds = layers.regions[id]?.getBounds();
    if (bounds?.isValid()) map.panTo(bounds.getCenter());
  }
}
