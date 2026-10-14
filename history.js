// HISTORY — undo/redo over JSON snapshots of the annotations

import { HISTORY_MAX, historyStack, layers, redoStack, state } from './state.js';
import { scheduleSave } from './persistence.js';
import { clearSelection } from './selection.js';
import { mountAll } from './render.js';
import { renderLayerStrip } from './layerstrip.js';
import { exitVertexEdit } from './shapes.js';

// HISTORY

export function pushHistory() {
  const snap = JSON.stringify(state.annotations);
  if (historyStack.length && historyStack[historyStack.length - 1] === snap) return;
  historyStack.push(snap);
  if (historyStack.length > HISTORY_MAX) historyStack.shift();
}

// redo stays valid only while annotations are untouched since the last undo/redo.
// checked lazily rather than in pushHistory, since focus handlers push without editing
let restoredSnap = null;

export function undo() {
  exitVertexEdit();
  const cur = JSON.stringify(state.annotations);
  if (cur !== restoredSnap) redoStack.length = 0;
  // skip no-op entries (focus pushes, cancelled merges) so undo always changes something
  while (historyStack.at(-1) === cur) historyStack.pop();
  if (!historyStack.length) return;
  redoStack.push(cur);
  restoreSnapshot(historyStack.pop());
}

export function redo() {
  exitVertexEdit();
  const cur = JSON.stringify(state.annotations);
  if (cur !== restoredSnap) redoStack.length = 0;
  if (!redoStack.length) return;
  pushHistory();
  restoreSnapshot(redoStack.pop());
}

function restoreSnapshot(json) {
  const snap = JSON.parse(json);
  Object.values(layers.pins).forEach(m => m.remove());
  Object.values(layers.regions).forEach(g => g.remove());
  layers.pins    = {};
  layers.regions = {};
  state.annotations = snap;
  // active layer may no longer exist after undo/redo
  if (!state.annotations.layers.some(l => l.id === state.ui.activeLayerId)) {
    state.ui.activeLayerId = state.annotations.layers[0]?.id ?? null;
  }
  mountAll();
  renderLayerStrip();
  clearSelection();
  restoredSnap = JSON.stringify(state.annotations);
  scheduleSave();
}
