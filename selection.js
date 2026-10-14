// SELECTION — what is selected, back/up navigation, and following it to its layer

import { layers, navStack, state } from './state.js';
import { findAnnotation, parentInView } from './nesting.js';
import { map } from './map.js';
import { applyInteractivity } from './render.js';
import { renderDetailPanel } from './panel.js';
import { renderLayerStrip } from './layerstrip.js';

// switch to an item's layer without dropping selection (panel / back navigation)
export function followToLayer(type, id) {
  const item = findAnnotation(type, id);
  if (item) showLayer(item.layerId);
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
  state.ui.selected = { type, id };
  followToLayer(type, id);
  renderDetailPanel();
}

export function navigateAnnotation(type, id) {
  if (state.ui.selected) navStack.push({ ...state.ui.selected });
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
  applyInteractivity();
  renderDetailPanel();
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
