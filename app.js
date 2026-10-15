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
import { clearSelection, goUp, hasSelection, pickMany, selectionItems, showLayer } from './selection.js';
import { activateMapElement, applyLayerVisibility, drillFocus, liveItems, peekFadedMark, regionFocusChanged } from './render.js';
import { renderDetailPanel } from './panel.js';
import { renderLayerStrip } from './layerstrip.js';
import { addPin, cancelRegionDraw, commitRegion, disarmDelete, draw, isDeleteArmed, requestDelete,
         startRegionDraw } from './create.js';
import { cancelMerge, exitVertexEdit, hideBrushCursor, vertexEdit } from './shapes.js';
import { initWorker, setWandStatus, triggerWand } from './wand.js';
import { openDocument, openSaved } from './project.js';
import { lettersLoaded, scheduleLabelLayout } from './labels.js';
import { isFolded, isMapOpen, renderFlap, setFolded, setMapOpen } from './flap.js';

// DOM

const toolsPanel       = document.getElementById('tools-panel');
const btnMode          = document.getElementById('btn-mode');
const btnRegion        = document.getElementById('tool-region');
const btnPin           = document.getElementById('tool-pin');
const btnWand          = document.getElementById('tool-wand');
const btnBrush         = document.getElementById('tool-brush');
const btnEraser        = document.getElementById('tool-eraser');
const btnEdit          = document.getElementById('tool-edit');
const btnMap           = document.getElementById('tool-map');
const btnFlapDone      = document.getElementById('flap-done');
const btnFlapFold      = document.getElementById('flap-fold');

// MODE — one switch, Display on one side and Design on the other

let linkShown = false;

function setMode(mode) {
  if (mode === 'design' && state.ui.shareLocked) return;
  state.mode = mode;
  const design = mode === 'design';
  toolsPanel.classList.toggle('hidden', !design);
  document.body.classList.toggle('designing', design);
  btnMode.setAttribute('aria-checked', design);
  if (design) map.boxZoom.disable(); else map.boxZoom.enable(); // design: shift-drag selects (or paints)
  if (!design) {
    setActiveTool(null);
    setMap(false);
    cancelRegionDraw();
  } else if (!linkShown && !document.getElementById('link-notice').classList.contains('hidden')) {
    linkShown = true; // a linked map isn't saved: say so once, the first time the cover opens
    setMap(true);
  }
  const sel = state.ui.selected;
  if (sel && !design && findAnnotation(sel.type, sel.id)?.hidden) { // can't stay selected once hidden
    navStack.length = 0;
    state.ui.selected = null;
  }
  if (!design) state.ui.picked = []; // gathering several is for editing
  applyLayerVisibility();
  renderLayerStrip();
  renderDetailPanel();
}

btnMode.addEventListener('click', () => {
  setMode(state.mode === 'design' ? 'display' : 'design');
});

// TOOLS — a roll of pockets; the tool in hand is gilded and its flap folds out beside the roll.
// the map file has a pocket too, and shares the flap

const TOOL_BTNS = {
  region: btnRegion,
  pin:    btnPin,
  wand:   btnWand,
  brush:  btnBrush,
  eraser: btnEraser,
  edit:   btnEdit,
};

// each tool's letter picks it up (and puts it down again)
const TOOL_KEYS = Object.fromEntries(Object.entries(TOOL_BTNS).map(([name, btn]) => [btn.dataset.key.toLowerCase(), name]));

// on a phone the roll is a dock along the bottom edge, and the leaf sits on top of it
const phone = window.matchMedia('(max-width: 640px)');

function measureDock() {
  document.body.style.setProperty('--dock-height', `${phone.matches ? toolsPanel.offsetHeight : 0}px`);
}
new ResizeObserver(measureDock).observe(toolsPanel);
phone.addEventListener('change', measureDock);

function setActiveTool(tool) {
  state.ui.activeTool = tool;
  if (tool && isMapOpen()) setMap(false);
  if (tool && state.ui.picked.length) clearSelection(); // taking up a tool lets go of a gathered selection

  for (const [name, b] of Object.entries(TOOL_BTNS)) {
    b.classList.toggle('active', name === tool);
    b.setAttribute('aria-pressed', name === tool);
  }

  const isPaint = tool === 'brush' || tool === 'eraser';
  if (!isPaint) hideBrushCursor();
  map.getContainer().style.cursor = isPaint ? 'none' : (tool ? 'crosshair' : '');
  if (isPaint) map.dragging.disable(); else map.dragging.enable();
  if (tool === 'region') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();

  if (tool !== 'region') cancelRegionDraw();
  if (tool !== 'wand')   setWandStatus('');
  if (tool !== 'edit')   exitVertexEdit();
  renderFlap();
}

function setMap(open) {
  if (open && state.ui.activeTool) setActiveTool(null);
  btnMap.classList.toggle('active', open);
  btnMap.setAttribute('aria-pressed', open);
  setMapOpen(open);
}

function toggleTool(name) {
  setActiveTool(state.ui.activeTool === name ? null : name);
}

for (const [name, b] of Object.entries(TOOL_BTNS)) b.addEventListener('click', () => toggleTool(name));

// opening the map file puts the cursor in its name (not on phones, where that raises the keyboard)
btnMap.addEventListener('click', () => {
  setMap(!isMapOpen());
  if (isMapOpen() && !phone.matches) document.getElementById('project-title').focus();
});

// folding the flap down to a tab keeps the tool in hand and frees the map's corner
btnFlapFold.addEventListener('click', () => setFolded(!isFolded()));

// putting the tool down hands focus back to its pocket
btnFlapDone.addEventListener('click', () => {
  const pocket = TOOL_BTNS[state.ui.activeTool] ?? btnMap;
  if (state.ui.activeTool) setActiveTool(null); else setMap(false);
  pocket.focus();
});

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
document.fonts?.ready.then(lettersLoaded);

// pins and regions are buttons: Enter or Space selects the focused one (Leaflet only makes them focusable);
// with shift held it's gathered with the others
map.getContainer().addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && activateMapElement(e.target, e)) e.preventDefault();
});

// SHIFT-DRAG — Design Mode, no tool in hand: a box drawn with shift held gathers what lies wholly
// inside it on the layer, adding to what's already selected. (A shift-click without a drag is left
// to the place clicked.) Display Mode keeps Leaflet's shift-drag zoom
const mapEl = map.getContainer();
let gather  = null; // { x, y, box }

const gathersHere = (e) => state.mode === 'design' && !state.ui.activeTool && e.shiftKey && e.button === 0;

mapEl.addEventListener('pointerdown', (e) => {
  if (!gathersHere(e) || e.pointerType !== 'mouse') return;
  gather = { x: e.clientX, y: e.clientY, box: null };
});
// the browser's own shift-click text selection would paint the map and the tabs as it's dragged
mapEl.addEventListener('mousedown', (e) => { if (gathersHere(e)) e.preventDefault(); });

document.addEventListener('pointermove', (e) => {
  if (!gather) return;
  if (!gather.box) {
    if (Math.hypot(e.clientX - gather.x, e.clientY - gather.y) < 5) return;
    gather.box = document.createElement('div');
    gather.box.className = 'gather-box';
    mapEl.appendChild(gather.box);
  }
  const r = mapEl.getBoundingClientRect();
  const [x0, x1] = [gather.x, e.clientX].sort((a, b) => a - b);
  const [y0, y1] = [gather.y, e.clientY].sort((a, b) => a - b);
  Object.assign(gather.box.style, { left: `${x0 - r.left}px`, top: `${y0 - r.top}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
});

let gathered = false; // the click that ends a drawn box mustn't also land on the map
document.addEventListener('pointerup', (e) => {
  const g = gather;
  gather = null;
  if (!g?.box) return;
  g.box.remove();
  const r = mapEl.getBoundingClientRect();
  const corner = (x, y) => map.containerPointToLatLng([x - r.left, y - r.top]);
  pickMany(liveItems(L.latLngBounds(corner(g.x, g.y), corner(e.clientX, e.clientY))), { add: true });
  gathered = true;
  setTimeout(() => { gathered = false; });
});
mapEl.addEventListener('click', (e) => { if (gathered) e.stopPropagation(); }, true);

// a focused region shows its name, and comes into view if it's off screen; the browser's own
// scroll-into-view would shift the map container out of alignment, so it's undone
map.getContainer().addEventListener('focusin', (e) => {
  if (!regionFocusChanged(e.target, true)) return;
  map.getContainer().scrollTop  = 0;
  map.getContainer().scrollLeft = 0;
});
map.getContainer().addEventListener('focusout', (e) => regionFocusChanged(e.target, false));

// a mouse resting on a faded mark names it (once per frame, mice only: a tap would leave it stuck)
let peekFrame = 0;
map.getContainer().addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || peekFrame) return;
  peekFrame = requestAnimationFrame(() => { peekFrame = 0; peekFadedMark(e.clientX, e.clientY); });
});
map.getContainer().addEventListener('pointerleave', () => peekFadedMark(null, null));

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
    const items = selectionItems();
    if (state.mode !== 'design' || !items.length || draw.active || state.ui.mergeSource) return;
    e.preventDefault();
    requestDelete(items);
    return;
  }
  // ⌘ / ctrl + A selects everything on the layer
  if ((e.metaKey || e.ctrlKey) && key === 'a' && state.mode === 'design' && !isTyping(e.target)) {
    e.preventDefault();
    if (state.ui.activeTool) setActiveTool(null);
    pickMany(liveItems());
    return;
  }
  const toolKey = TOOL_KEYS[key];
  if (toolKey && state.mode === 'design' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)
      && !draw.active && !e.repeat) {
    e.preventDefault();
    toggleTool(toolKey);
    return;
  }
  // [ and ] shrink and grow the brush (and the eraser, which shares its size)
  if ((e.key === '[' || e.key === ']') && ['brush', 'eraser'].includes(state.ui.activeTool) && !isTyping(e.target)) {
    const size = document.getElementById('brush-size');
    size.value = +size.value + (e.key === ']' ? 5 : -5);
    size.dispatchEvent(new Event('input'));
    return;
  }
  if (e.key !== 'Escape') return;
  if (isMapOpen() && !state.ui.activeTool) { setMap(false); btnMap.focus(); return; }
  // esc unwinds the innermost thing first; deselect only when nothing else was cancelled
  const busy = draw.active || state.ui.mergeSource || vertexEdit.active || state.ui.activeTool === 'edit'
            || isDeleteArmed();
  disarmDelete();
  if (draw.active)            cancelRegionDraw();
  if (state.ui.mergeSource)   cancelMerge();
  if (vertexEdit.active)      exitVertexEdit();
  if (state.ui.activeTool === 'edit') setActiveTool(null);
  if (busy || e.target.isContentEditable) return; // layer rename handles its own esc
  if (!hasSelection()) {
    // nothing left to let go of: the tool in hand is put down
    const pocket = TOOL_BTNS[state.ui.activeTool];
    if (pocket && !typedFields.has(e.target)) { setActiveTool(null); pocket.focus(); }
    return;
  }
  if (typedFields.has(e.target)) { e.target.blur(); return; }       // first esc leaves a field you typed in
  if (state.mode === 'display') goUp(); else clearSelection();
});

// INIT

initWorker();

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
