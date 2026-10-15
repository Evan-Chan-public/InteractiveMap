// LAYER STRIP — the layer chips (top-left): switch, add, rename, reorder, delete; moving items between layers

import { layers, state } from './state.js';
import { generateId, ICON_EYE, ICON_EYE_OFF, ICON_X } from './utils.js';
import { scheduleSave } from './persistence.js';
import { findAnnotation, orphanChildrenOf, renestAround } from './nesting.js';
import { pushHistory } from './history.js';
import { clearSelection, followToLayer } from './selection.js';
import { applyInteractivity, applyZOrder, remountRegionLayer, toggleLayerView, unmountRegion } from './render.js';
import { refreshLayerList } from './panel.js';
import { cancelMerge } from './shapes.js';
import { renderFlap } from './flap.js';

// DOM

const layerChips       = document.getElementById('layer-chips');
const btnLayerAdd      = document.getElementById('layer-add');

// LAYERS

// focusTarget: after a re-render, put the keyboard back on this layer's chip ('name' | 'eye')
export function renderLayerStrip(focusTarget = null) {
  renderFlap(); // the flap names the open layer
  layerChips.innerHTML = '';
  const editable = state.mode === 'design';
  const onlyOne  = state.annotations.layers.length === 1;
  btnLayerAdd.classList.toggle('hidden', !editable);

  state.annotations.layers.forEach(layer => {
    const chip = document.createElement('div');
    chip.className = 'layer-chip' + (layer.id === state.ui.activeLayerId ? ' active' : '');
    chip.dataset.id = layer.id;
    chip.draggable  = editable;

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'layer-chip-name';
    name.textContent = layer.name;
    name.setAttribute('aria-pressed', layer.id === state.ui.activeLayerId);
    if (editable) name.title = 'Double-click or F2 to rename · Alt+←/→ to reorder';
    chip.appendChild(name);

    const viewHidden = editable && state.ui.viewHiddenLayers.has(layer.id);
    chip.classList.toggle('view-hidden', viewHidden);
    if (editable) {
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'layer-chip-eye';
      eye.innerHTML = viewHidden ? ICON_EYE_OFF : ICON_EYE;
      eye.title = viewHidden ? 'Show this layer' : 'Hide this layer while editing (not saved; viewers still see it)';
      eye.setAttribute('aria-label', `${viewHidden ? 'Show' : 'Hide'} ${layer.name} while editing`);
      eye.setAttribute('aria-pressed', viewHidden);
      chip.appendChild(eye);
    }

    if (editable && !onlyOne) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'layer-chip-close';
      close.innerHTML = ICON_X;
      close.title = 'Delete layer';
      close.setAttribute('aria-label', `Delete layer ${layer.name}`);
      chip.appendChild(close);
    }

    chip.addEventListener('click', (e) => {
      if (e.target.closest('.layer-chip-input')) return;
      if (e.target.closest('.layer-chip-eye')) {
        toggleLayerView(layer.id);
        refocusChip(layer.id, 'eye');
        return;
      }
      const close = e.target.closest('.layer-chip-close');
      if (close) { handleLayerDelete(layer.id, close); return; }
      const hadFocus = layerChips.contains(document.activeElement);
      setActiveLayer(layer.id);
      if (hadFocus) refocusChip(layer.id);
    });

    if (editable) {
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRenameLayer(layer.id, chip, name);
      });
      name.addEventListener('keydown', (e) => {
        if (e.key === 'F2') { e.preventDefault(); startRenameLayer(layer.id, chip, name); return; }
        const step = e.altKey ? { ArrowLeft: -1, ArrowRight: 1 }[e.key] : 0;
        if (step) { e.preventDefault(); moveLayer(layer.id, step); }
      });
    }

    chip.addEventListener('dragstart', (e) => {
      if (chip.querySelector('.layer-chip-input')) { e.preventDefault(); return; }
      chip.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', layer.id);
    });
    chip.addEventListener('dragend', () => {
      chip.classList.remove('dragging');
      layerChips.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    chip.addEventListener('dragover', (e) => {
      e.preventDefault();
      chip.classList.add('drag-over');
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('drag-over'));
    chip.addEventListener('drop', (e) => {
      e.preventDefault();
      chip.classList.remove('drag-over');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (draggedId && draggedId !== layer.id) reorderLayer(draggedId, layer.id);
    });

    layerChips.appendChild(chip);
  });
  if (focusTarget) refocusChip(focusTarget.id, focusTarget.part);
}

// the strip is rebuilt on every change; keyboard users keep their place on the chip they used
function refocusChip(id, part = 'name') {
  const chip = layerChips.querySelector(`.layer-chip[data-id="${CSS.escape(id)}"]`);
  chip?.querySelector(part === 'eye' ? '.layer-chip-eye' : '.layer-chip-name')?.focus();
}

// one step left (lower) or right (higher) in the stack: the keyboard and touch route for reordering
export function moveLayer(id, step) {
  const arr  = state.annotations.layers;
  const from = arr.findIndex(l => l.id === id);
  const to   = from + step;
  if (from < 0 || to < 0 || to >= arr.length) return;
  const hadFocus = layerChips.contains(document.activeElement);
  reorderLayer(id, arr[to].id);
  if (hadFocus) refocusChip(id);
}

function reorderLayer(draggedId, targetId) {
  const arr = state.annotations.layers;
  const from = arr.findIndex(l => l.id === draggedId);
  const to   = arr.findIndex(l => l.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  pushHistory();
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);
  renderLayerStrip();
  applyZOrder();
  refreshLayerList(); // the list's move buttons depend on the order
  scheduleSave();
}

// layer chip: design keeps a selection that's on the layer; display always leaves the drill-down
function setActiveLayer(id) {
  const sel = state.ui.selected;
  if (sel && (state.mode === 'display' || findAnnotation(sel.type, sel.id)?.layerId !== id)) clearSelection();
  if (state.ui.activeLayerId === id) return;
  state.ui.activeLayerId = id;
  if (state.ui.mergeSource) cancelMerge();
  renderLayerStrip();
  applyInteractivity();
  refreshLayerList();
}

export function moveToLayer(type, item, layerId) {
  if (item.layerId === layerId) return;
  pushHistory();
  item.layerId = layerId;
  renestAround(item);
  if (type === 'region') remountRegionLayer(item); // restack at new position
  followToLayer(type, item.id);
  scheduleSave();
}

function addLayer() {
  pushHistory();
  const layer = { id: generateId(), name: `Layer ${state.annotations.layers.length + 1}` };
  state.annotations.layers.push(layer);
  state.ui.activeLayerId = layer.id;
  renderLayerStrip();
  applyInteractivity();
  refreshLayerList();
  scheduleSave();
}

let pendingDelete = { id: null, timer: null };
function handleLayerDelete(id, closeEl) {
  if (pendingDelete.id === id) {
    clearTimeout(pendingDelete.timer);
    pendingDelete = { id: null, timer: null };
    deleteLayer(id);
    return;
  }
  if (pendingDelete.id) clearTimeout(pendingDelete.timer);
  const label = closeEl.getAttribute('aria-label');
  closeEl.classList.add('confirm');
  closeEl.setAttribute('aria-label', `Confirm: ${label}`);
  pendingDelete.id = id;
  pendingDelete.timer = setTimeout(() => {
    closeEl.classList.remove('confirm');
    closeEl.setAttribute('aria-label', label);
    pendingDelete = { id: null, timer: null };
  }, 2500);
}

function deleteLayer(id) {
  if (state.annotations.layers.length <= 1) return;
  pushHistory();

  // remove all regions and pins in this layer (and their Leaflet layers)
  const removedIds = state.annotations.regions.filter(r => r.layerId === id).map(r => r.id);
  state.annotations.regions = state.annotations.regions.filter(r => {
    if (r.layerId !== id) return true;
    unmountRegion(r.id);
    return false;
  });
  state.annotations.pins = state.annotations.pins.filter(p => {
    if (p.layerId !== id) return true;
    layers.pins[p.id]?.remove();
    delete layers.pins[p.id];
    return false;
  });

  const idx = state.annotations.layers.findIndex(l => l.id === id);
  state.annotations.layers.splice(idx, 1);
  orphanChildrenOf(removedIds);

  if (state.ui.activeLayerId === id) {
    const fallback = state.annotations.layers[Math.max(0, idx - 1)];
    state.ui.activeLayerId = fallback.id;
  }
  if (state.ui.selected) clearSelection();

  renderLayerStrip();
  applyInteractivity();
  refreshLayerList();
  scheduleSave();
}

// renaming swaps the chip's name for a text field: Enter keeps it, Esc or an empty name doesn't
function startRenameLayer(id, chip, nameBtn) {
  const layer = state.annotations.layers.find(l => l.id === id);
  if (!layer) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'layer-chip-input';
  input.value = layer.name;
  input.maxLength = 80;
  input.setAttribute('aria-label', 'Layer name');
  chip.draggable = false;
  nameBtn.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    if (keep && next && next !== layer.name) {
      pushHistory();
      layer.name = next;
      refreshLayerList();
      scheduleSave();
    }
    renderLayerStrip({ id, part: 'name' });
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the map's Esc / Backspace shortcuts don't apply while typing a name
    if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
}

btnLayerAdd.addEventListener('click', addLayer);
