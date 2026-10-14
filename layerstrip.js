// LAYER STRIP — the layer chips (top-left): switch, add, rename, reorder, delete; moving items between layers

import { layers, state } from './state.js';
import { generateId } from './utils.js';
import { scheduleSave } from './persistence.js';
import { findAnnotation, orphanChildrenOf, renestAround } from './nesting.js';
import { pushHistory } from './history.js';
import { clearSelection, followToLayer } from './selection.js';
import { applyInteractivity, applyZOrder, remountRegionLayer, unmountRegion } from './render.js';
import { refreshLayerList } from './panel.js';
import { cancelMerge } from './shapes.js';

// DOM

const layerChips       = document.getElementById('layer-chips');
const btnLayerAdd      = document.getElementById('layer-add');

// LAYERS

export function renderLayerStrip() {
  layerChips.innerHTML = '';
  const editable = state.mode === 'design';
  const onlyOne  = state.annotations.layers.length === 1;
  btnLayerAdd.classList.toggle('hidden', !editable);

  state.annotations.layers.forEach(layer => {
    const chip = document.createElement('div');
    chip.className = 'layer-chip' + (layer.id === state.ui.activeLayerId ? ' active' : '');
    chip.dataset.id = layer.id;
    chip.draggable  = editable;

    const name = document.createElement('span');
    name.className = 'layer-chip-name';
    name.textContent = layer.name;
    chip.appendChild(name);

    if (editable && !onlyOne) {
      const close = document.createElement('span');
      close.className = 'layer-chip-close';
      close.textContent = '×';
      close.title = 'Delete layer';
      chip.appendChild(close);
    }

    chip.addEventListener('click', (e) => {
      if (e.target === name && name.isContentEditable) return;
      if (e.target.classList.contains('layer-chip-close')) {
        handleLayerDelete(layer.id, e.target);
        return;
      }
      setActiveLayer(layer.id);
    });

    if (editable) {
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRenameLayer(layer.id, name);
      });
    }

    chip.addEventListener('dragstart', (e) => {
      if (name.isContentEditable) { e.preventDefault(); return; }
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
  closeEl.classList.add('confirm');
  pendingDelete.id = id;
  pendingDelete.timer = setTimeout(() => {
    closeEl.classList.remove('confirm');
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

function startRenameLayer(id, nameEl) {
  nameEl.contentEditable = 'true';
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const commit = () => {
    nameEl.contentEditable = 'false';
    nameEl.removeEventListener('blur', commit);
    nameEl.removeEventListener('keydown', onKey);
    const layer = state.annotations.layers.find(l => l.id === id);
    const next  = nameEl.textContent.trim();
    if (layer && next && next !== layer.name) {
      pushHistory();
      layer.name = next;
      refreshLayerList();
      scheduleSave();
    } else if (layer) {
      nameEl.textContent = layer.name;
    }
  };
  const onKey = (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); nameEl.textContent = state.annotations.layers.find(l => l.id === id)?.name || ''; nameEl.blur(); }
  };
  nameEl.addEventListener('blur', commit);
  nameEl.addEventListener('keydown', onKey);
}

btnLayerAdd.addEventListener('click', addLayer);
