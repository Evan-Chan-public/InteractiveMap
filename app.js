// APP — entry point: mode, tools, map/keyboard events and startup. Everything else lives in modules:
//   map · render (leaflet layers, interactivity) · selection · panel (right panel) · layerstrip
//   create (pins, regions, delete) · shapes (merge, vertex edit, brush/eraser) · wand · image · share · history
//   project (file format, open/import/export) · persistence (autosave)
//
// modules import each other in cycles; that is safe because only this file runs code at load time.
// the others just declare functions and wire listeners on their own elements.

import { navStack, state } from './state.js';
import { pointInRing } from './utils.js';
import { findAnnotation } from './nesting.js';
import { fetchLinkedFile, linkedFile, readShareHash, showBanner } from './share.js';
import { map } from './map.js';
import { redo, undo } from './history.js';
import { clearSelection, goUp, showLayer } from './selection.js';
import { applyLayerVisibility, drillFocus } from './render.js';
import { renderDetailPanel } from './panel.js';
import { renderLayerStrip } from './layerstrip.js';
import { addPin, cancelRegionDraw, commitRegion, disarmDelete, draw, isDeleteArmed, requestDelete,
         startRegionDraw } from './create.js';
import { cancelMerge, exitVertexEdit, hideBrushCursor, vertexEdit } from './shapes.js';
import { initWorker, setWandStatus, triggerWand } from './wand.js';
import { openDocument, openSaved } from './project.js';
import { scheduleLabelLayout } from './labels.js';

// DOM

const toolsPanel       = document.getElementById('tools-panel');
const btnMode          = document.getElementById('btn-mode');
const btnRegion        = document.getElementById('tool-region');
const btnPin           = document.getElementById('tool-pin');
const btnWand          = document.getElementById('tool-wand');
const btnBrush         = document.getElementById('tool-brush');
const btnEraser        = document.getElementById('tool-eraser');
const btnEdit          = document.getElementById('tool-edit');
const wandOptions      = document.getElementById('wand-options');
const brushControls    = document.getElementById('brush-controls');

// MODE

function setMode(mode) {
  if (mode === 'design' && state.ui.shareLocked) return;
  state.mode = mode;
  if (mode === 'design') {
    toolsPanel.classList.remove('hidden');
    btnMode.textContent = 'Switch to Display Mode';
  } else {
    toolsPanel.classList.add('hidden');
    btnMode.textContent = 'Switch to Design Mode';
    setActiveTool(null);
    cancelRegionDraw();
  }
  const sel = state.ui.selected;
  if (sel && mode === 'display' && findAnnotation(sel.type, sel.id)?.hidden) { // can't stay selected once hidden
    navStack.length = 0;
    state.ui.selected = null;
  }
  applyLayerVisibility();
  renderLayerStrip();
  renderDetailPanel();
}

btnMode.addEventListener('click', () => {
  setMode(state.mode === 'design' ? 'display' : 'design');
});

// TOOLS

const TOOL_BTNS = {
  region: btnRegion,
  pin:    btnPin,
  wand:   btnWand,
  brush:  btnBrush,
  eraser: btnEraser,
  edit:   btnEdit,
};

function setActiveTool(tool) {
  state.ui.activeTool = tool;

  Object.values(TOOL_BTNS).forEach(b => b?.classList.remove('active'));
  if (tool) TOOL_BTNS[tool]?.classList.add('active');

  wandOptions?.classList.toggle('hidden', tool !== 'wand');
  brushControls?.classList.toggle('hidden', tool !== 'brush' && tool !== 'eraser');

  const isPaint = tool === 'brush' || tool === 'eraser';
  if (!isPaint) hideBrushCursor();
  map.getContainer().style.cursor = isPaint ? 'none' : (tool ? 'crosshair' : '');
  if (isPaint) map.dragging.disable(); else map.dragging.enable();
  if (isPaint) map.boxZoom.disable();  else map.boxZoom.enable(); // shift+drag belongs to the brush
  if (tool === 'region') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();

  if (tool !== 'region') cancelRegionDraw();
  if (tool !== 'wand')   setWandStatus('');
  if (tool !== 'edit')   exitVertexEdit();
}

function wireToolBtn(btn, name) {
  btn?.addEventListener('click', () => setActiveTool(state.ui.activeTool === name ? null : name));
}

wireToolBtn(btnRegion, 'region');
wireToolBtn(btnPin,    'pin');
wireToolBtn(btnWand,   'wand');
wireToolBtn(btnBrush,  'brush');
wireToolBtn(btnEraser, 'eraser');
wireToolBtn(btnEdit,   'edit');

// MAP EVENTS

// display: a click outside the drill-down (or the selection) leaves it for the outermost layer.
// clicks inside it reach here through faded items and the frame, and are ignored
function onDisplayMapClick(latlng) {
  const sel = state.ui.selected;
  if (!sel) return;
  const area = drillFocus() ?? (sel.type === 'region' ? findAnnotation('region', sel.id) : null);
  if (area?.polygons.some(ring => pointInRing(latlng, ring))) return;
  showLayer(state.annotations.layers[0].id);
  clearSelection();
}

map.on('click', (e) => {
  if (state.mode !== 'design') { onDisplayMapClick(e.latlng); return; }
  if      (state.ui.activeTool === 'pin')    addPin(e.latlng);
  else if (state.ui.activeTool === 'region') startRegionDraw(e.latlng);
  else if (state.ui.activeTool === 'wand')   triggerWand(e.latlng);
  else if (state.ui.mergeSource)             cancelMerge();
  else                                        clearSelection();
});

// pin names are placed in screen space: re-letter after the view changes, and once the map
// typeface has loaded (names change width)
map.on('zoomend moveend resize', scheduleLabelLayout);
document.fonts?.ready.then(scheduleLabelLayout);

map.on('dblclick', (e) => {
  if (state.mode !== 'design') return;
  if (state.ui.activeTool === 'region') {
    L.DomEvent.stopPropagation(e);
    commitRegion();
  }
});

// keys inside a text field belong to the field (checkboxes, sliders and buttons don't count)
function isTyping(el) {
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(el.type);
}

// text fields the user has typed in keep native ctrl+z (fields are rebuilt on each render)
const typedFields = new WeakSet();
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.type === 'text') typedFields.add(t);
});

document.addEventListener('keydown', (e) => {
  const key    = e.key?.toLowerCase();
  const isUndo = (e.metaKey || e.ctrlKey) && key === 'z' && !e.shiftKey;
  const isRedo = ((e.metaKey || e.ctrlKey) && key === 'z' && e.shiftKey) || (e.ctrlKey && key === 'y');
  if (isUndo || isRedo) {
    if (typedFields.has(e.target)) return;
    e.preventDefault();
    if (isUndo) undo(); else redo();
    return;
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && !isTyping(e.target)) {
    const sel = state.ui.selected;
    if (state.mode !== 'design' || !sel || draw.active || state.ui.mergeSource) return;
    e.preventDefault();
    requestDelete(sel.type, sel.id);
    return;
  }
  if (e.key !== 'Escape') return;
  // esc unwinds the innermost thing first; deselect only when nothing else was cancelled
  const busy = draw.active || state.ui.mergeSource || vertexEdit.active || state.ui.activeTool === 'edit'
            || isDeleteArmed();
  disarmDelete();
  if (draw.active)            cancelRegionDraw();
  if (state.ui.mergeSource)   cancelMerge();
  if (vertexEdit.active)      exitVertexEdit();
  if (state.ui.activeTool === 'edit') setActiveTool(null);
  if (busy || !state.ui.selected || e.target.isContentEditable) return; // layer rename handles its own esc
  if (typedFields.has(e.target)) { e.target.blur(); return; }       // first esc leaves a field you typed in
  if (state.mode === 'display') goUp(); else clearSelection();
});

// INIT

initWorker();
if (typeof lucide !== 'undefined') lucide.createIcons();

// a linked map file (?gist= / ?project=) or a share link opens as a separate map that isn't saved
// unless it's kept; otherwise the saved map
const linked   = linkedFile();
const hashData = location.hash.slice(1);
if (linked) {
  showBanner('Loading map…');
  const { doc, error } = linked.url ? await fetchLinkedFile(linked.url) : { error: linked.error };
  showBanner(error ? `Couldn't open the linked map: ${error}.` : '');
  await openDocument(doc ?? { title: '', image: null, annotations: { layers: [], regions: [], pins: [] } },
                     { autosave: false, locked: !linked.edit });
} else {
  const shared = hashData ? await readShareHash(hashData) : null;
  if (shared) await openDocument(shared.doc, { autosave: false, locked: shared.lock });
  else        await openSaved();
}

if (state.ui.shareLocked) btnMode.style.display = 'none';
setMode('display');
