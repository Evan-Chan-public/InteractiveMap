// PANEL — the right panel: layer list, details view, editor, nesting tree, merge preview

import { navStack, state } from './state.js';
import { escapeHtml } from './utils.js';
import { scheduleSave } from './persistence.js';
import { ancestorsOf, autoParent, childrenInView, countInView, findAnnotation, findItem,
         parentInView, renest, renestAll, visibleInMode, wouldCycle } from './nesting.js';
import { map } from './map.js';
import { pushHistory } from './history.js';
import { clearSelection, goBack, navigateAnnotation, panToItem, selectAnnotation } from './selection.js';
import { applyLayerVisibility, updatePinLayer, updateRegionLayer } from './render.js';
import { moveToLayer } from './layerstrip.js';
import { deleteAnnotation } from './create.js';
import { cancelMerge, consolidateRegion, startMerge } from './shapes.js';

// DOM

const detailPanel      = document.getElementById('detail-panel');
const detailHeader     = detailPanel.querySelector('.panel-header');
const detailContent    = document.getElementById('detail-content');
const detailTree       = document.getElementById('detail-tree');

// SWATCHES

const SWATCH_COLORS = [
  '#000000','#434343','#666666','#999999','#cccccc','#e6e6e6','#f3f3f3','#ffffff',
  '#ff0000','#ff7700','#ffff00','#00cc00','#00cccc','#4a9eff','#7700cc','#ff00cc',
  '#f4cccc','#fce5cd','#fff2cc','#d9ead3','#d0e0e3','#cfe2f3','#d9d2e9','#ead1dc',
  '#ea9999','#f9cb9c','#ffe599','#b6d7a8','#a2c4c9','#9fc5e8','#b4a7d6','#d5a6bd',
  '#cc0000','#e69138','#f1c232','#6aa84f','#45818e','#3d85c8','#674ea7','#a64d79',
];

function renderSwatchGrid(currentColor) {
  const cur = (currentColor || '#4a9eff').toLowerCase();
  const inPreset = SWATCH_COLORS.map(c => c.toLowerCase()).includes(cur);
  const swatches = SWATCH_COLORS.map(c => {
    const active = c.toLowerCase() === cur ? ' active' : '';
    return `<div class="swatch${active}" style="background:${c}" data-color="${c}" title="${c}"></div>`;
  }).join('');
  return `
    <div id="swatch-grid" class="swatch-grid">
      ${swatches}
      <div class="swatch swatch-custom${!inPreset ? ' active' : ''}" id="swatch-custom-btn" title="Custom colour">…</div>
    </div>
    <input id="edit-color-custom" type="color" value="${escapeHtml(currentColor || '#4a9eff')}" style="display:none" />
  `;
}

function bindSwatchGrid(annotation) {
  const grid        = document.getElementById('swatch-grid');
  const customBtn   = document.getElementById('swatch-custom-btn');
  const customInput = document.getElementById('edit-color-custom');
  const colorDot    = document.querySelector('.swatch-summary .color-dot');
  const syncDot     = (c) => { if (colorDot) colorDot.style.background = c; };

  grid.addEventListener('click', (e) => {
    const swatch = e.target.closest('[data-color]');
    if (!swatch) return;
    pushHistory();
    annotation.color = swatch.dataset.color;
    customInput.value = annotation.color;
    syncDot(annotation.color);
    grid.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');
    customBtn.classList.remove('active');
    updateRegionLayer(annotation);
    scheduleSave();
  });

  customBtn.addEventListener('click', () => customInput.click());

  customInput.addEventListener('focus', () => { pushHistory(); });
  customInput.addEventListener('input', (e) => {
    annotation.color = e.target.value;
    syncDot(annotation.color);
    grid.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
    customBtn.classList.add('active');
    updateRegionLayer(annotation);
    scheduleSave();
  });
}

// DETAIL PANEL

export function renderDetailPanel() {
  const sel = state.ui.selected;

  if (state.ui.mergeSource && state.ui.mergeHover
      && state.ui.mergeSource !== state.ui.mergeHover) {
    const source = state.annotations.regions.find(r => r.id === state.ui.mergeSource);
    const target = state.annotations.regions.find(r => r.id === state.ui.mergeHover);
    if (source && target) { renderDetailTree(null); renderMergePreview(source, target); return; }
  }

  setPanelVisible(!!sel || showsLayerList());
  detailHeader.textContent = sel ? 'Details' : 'Layer';

  if (!sel) {
    renderDetailTree(null);
    if (showsLayerList()) renderLayerList();
    else detailContent.innerHTML = '<p class="detail-empty">Click a region or pin to see details.</p>';
    return;
  }

  const list = sel.type === 'region' ? state.annotations.regions : state.annotations.pins;
  const annotation = list.find(a => a.id === sel.id);
  if (!annotation) { clearSelection(); return; }

  renderDetailTree(annotation);

  if (state.mode === 'design') {
    renderDetailEditor(annotation, sel.type);
  } else {
    renderDetailView(annotation);
  }
}

// LAYER LIST (right panel, nothing selected)

function showsLayerList() {
  return state.mode === 'design' && !!state.image;
}

function setPanelVisible(visible) {
  if (detailPanel.classList.contains('hidden') !== visible) return;
  detailPanel.classList.toggle('hidden', !visible);
  map.invalidateSize(); // map container width changed
}

// re-render the list if it's what the panel is showing
export function refreshLayerList() {
  if (!state.ui.selected) renderDetailPanel();
}

function renderLayerList() {
  const layer   = state.annotations.layers.find(l => l.id === state.ui.activeLayerId);
  const regions = state.annotations.regions.filter(r => r.layerId === layer?.id);
  const pins    = state.annotations.pins.filter(p => p.layerId === layer?.id);

  const row = (type, a) => `
    <div class="pin-list-item item-row${a.hidden ? ' item-hidden' : ''}" data-type="${type}" data-id="${escapeHtml(a.id)}">
      ${type === 'region' ? `<span class="color-wheel" style="background:${escapeHtml(a.color || '#4a9eff')}"></span>` : ''}
      <span class="item-row-label">${escapeHtml(a.label || (type === 'region' ? 'Untitled region' : 'Untitled pin'))}</span>
      ${a.parentId ? `<span class="item-row-parent">in ${escapeHtml(findItem(a.parentId)?.label || 'Untitled')}</span>` : ''}
    </div>`;
  const section = (title, type, items) => items.length ? `
    <details class="pin-list" open>
      <summary class="pin-list-summary">${title} (${items.length})</summary>
      ${items.map(a => row(type, a)).join('')}
    </details>` : '';

  const sections = section('Regions', 'region', regions) + section('Pins', 'pin', pins);
  detailContent.innerHTML = `
    <h2 class="detail-title">${escapeHtml(layer?.name || 'Layer')}</h2>
    ${sections || '<p class="detail-empty">Nothing on this layer yet.</p>'}
    <div class="editor-actions renest-actions">
      <button id="renest-layer" class="btn-secondary" title="Re-run automatic nesting for this layer's items (manual parents are kept)">Re-nest layer</button>
      <button id="renest-all" class="btn-secondary" title="Re-run automatic nesting for every item (manual parents are kept)">Re-nest all</button>
    </div>
  `;

  const bindRenest = (btnId, layerId) => {
    document.getElementById(btnId)?.addEventListener('click', () => {
      pushHistory();
      renestAll(layerId);
      scheduleSave();
      renderLayerList();
      const btn = document.getElementById(btnId);
      if (btn) { btn.textContent = 'Done'; setTimeout(() => { btn.textContent = btnId === 'renest-all' ? 'Re-nest all' : 'Re-nest layer'; }, 1200); }
    });
  };
  bindRenest('renest-layer', layer?.id);
  bindRenest('renest-all', null);

  detailContent.querySelectorAll('.item-row').forEach(el => {
    el.addEventListener('click', () => {
      const { type, id } = el.dataset;
      selectAnnotation(type, id);
      panToItem(type, id);
    });
  });
}

// descriptions can arrive in share links: markdown output is sanitized, or shown as plain text
function bodyHtml(body) {
  if (!body) return '<em style="color:#888">No description.</em>';
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return escapeHtml(body);
  return DOMPurify.sanitize(marked.parse(body));
}

function renderMergePreview(source, target) {
  detailContent.innerHTML = `
    <div class="merge-banner">
      Click to merge into
      <span class="color-wheel" style="background:${escapeHtml(source.color || '#4a9eff')}"></span>
      <strong>${escapeHtml(source.label || 'Untitled')}</strong>
    </div>
    <h2 class="merge-target-title">
      <span class="color-wheel" style="background:${escapeHtml(target.color || '#4a9eff')}"></span>
      ${escapeHtml(target.label || 'Untitled')}
    </h2>
    <div class="detail-body markdown-body">${bodyHtml(target.body)}</div>
  `;
}

function backButtonHtml() {
  if (!navStack.length && state.mode === 'display') {
    const sel    = state.ui.selected;
    const parent = sel && parentInView(findAnnotation(sel.type, sel.id));
    return parent ? `<button id="nav-back" class="btn-back">← ${escapeHtml(parent.label || 'Untitled')}</button>` : '';
  }
  if (!navStack.length) {
    if (!showsLayerList()) return '';
    const layer = state.annotations.layers.find(l => l.id === state.ui.activeLayerId);
    return `<button id="nav-back" class="btn-back">← ${escapeHtml(layer?.name || 'Layer')}</button>`;
  }
  const prev = navStack[navStack.length - 1];
  const list = prev.type === 'region' ? state.annotations.regions : state.annotations.pins;
  const label = list.find(a => a.id === prev.id)?.label || 'Untitled';
  return `<button id="nav-back" class="btn-back">← ${escapeHtml(label)}</button>`;
}

function bindBackButton() {
  document.getElementById('nav-back')?.addEventListener('click', goBack);
}

function renderDetailView(annotation) {
  detailContent.innerHTML = `
    ${backButtonHtml()}
    <h2 class="detail-title">${escapeHtml(annotation.label || 'Untitled')}</h2>
    <hr class="detail-divider" />
    <div class="detail-body markdown-body">${bodyHtml(annotation.body)}</div>
  `;
  bindBackButton();
}

function renderDetailEditor(annotation, type) {
  const isRegion = type === 'region';

  const colorSwatch = isRegion ? `
    <details class="swatch-details">
      <summary class="swatch-summary">
        <span class="field-label" style="display:inline">Color</span>
        <span class="color-dot" style="background:${escapeHtml(annotation.color || '#4a9eff')}"></span>
      </summary>
      ${renderSwatchGrid(annotation.color)}
    </details>` : '';

  const mergeBanner = (isRegion && state.ui.mergeSource === annotation.id)
    ? `<div class="merge-banner">
         Click another region to merge into this one.
         <button id="edit-merge-cancel" class="btn-link">Cancel</button>
       </div>`
    : '';

  const layerSelect = state.annotations.layers.length > 1 ? `
    <label class="field-label" for="edit-layer">Layer</label>
    <select id="edit-layer" class="field-input">
      ${state.annotations.layers.map(l => `
        <option value="${escapeHtml(l.id)}" ${l.id === annotation.layerId ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}
    </select>` : '';

  const parentSelect = (() => {
    const auto      = autoParent(annotation);
    const autoLabel = auto ? escapeHtml(findItem(auto)?.label || 'Untitled') : 'top level';
    const current   = annotation.parentManual ? (annotation.parentId ?? '__none') : '';
    const groups    = state.annotations.layers
      .filter(l => type === 'pin' || l.id !== annotation.layerId) // pins may sit in a same-layer region
      .map(l => {
        const opts = state.annotations.regions
          .filter(r => r.layerId === l.id && !wouldCycle(annotation.id, r.id))
          .map(r => `<option value="${escapeHtml(r.id)}" ${current === r.id ? 'selected' : ''}>${escapeHtml(r.label || 'Untitled')}</option>`)
          .join('');
        return opts ? `<optgroup label="${escapeHtml(l.name)}">${opts}</optgroup>` : '';
      }).join('');
    return `
      <label class="field-label" for="edit-parent">Parent</label>
      <select id="edit-parent" class="field-input">
        <option value="" ${current === '' ? 'selected' : ''}>Auto (${autoLabel})</option>
        <option value="__none" ${current === '__none' ? 'selected' : ''}>None (top level)</option>
        ${groups}
      </select>`;
  })();

  const polyCount = isRegion ? annotation.polygons.length : 0;
  const polyHint  = isRegion
    ? `<div class="field-label" style="margin-top:6px">${polyCount} polygon${polyCount === 1 ? '' : 's'}</div>`
    : '';

  const actionBtns = isRegion ? `
    <button id="edit-merge" class="btn-secondary">Merge…</button>
    ${polyCount > 1 ? `<button id="edit-consolidate" class="btn-secondary">Consolidate</button>` : ''}
    <button id="edit-delete" class="btn-danger">Delete</button>
  ` : `<button id="edit-delete" class="btn-danger">Delete</button>`;

  detailContent.innerHTML = `
    ${backButtonHtml()}
    <div class="detail-editor">
      ${mergeBanner}

      <label class="field-label" for="edit-label">Label</label>
      <input id="edit-label" type="text" class="field-input"
             value="${escapeHtml(annotation.label || '')}" placeholder="Label…" />

      ${layerSelect}
      ${parentSelect}
      ${colorSwatch}
      ${polyHint}

      <label class="field-label" for="edit-body">Description <span class="field-hint">(Markdown)</span></label>
      <textarea id="edit-body" class="field-textarea"
                placeholder="Description…">${escapeHtml(annotation.body || '')}</textarea>

      <label class="field-toggle" for="edit-hidden">
        <input id="edit-hidden" type="checkbox" ${annotation.hidden ? 'checked' : ''} />
        Hide in display mode
      </label>

      <div class="editor-actions">${actionBtns}</div>
    </div>
  `;

  const labelInput  = document.getElementById('edit-label');
  const bodyInput   = document.getElementById('edit-body');
  const hiddenCheck = document.getElementById('edit-hidden');

  labelInput.addEventListener('focus', pushHistory);
  labelInput.addEventListener('input', () => {
    annotation.label = labelInput.value;
    if (type === 'pin')    updatePinLayer(annotation);
    if (type === 'region') updateRegionLayer(annotation);
    scheduleSave();
  });

  bodyInput.addEventListener('focus', pushHistory);
  bodyInput.addEventListener('input', () => {
    annotation.body = bodyInput.value;
    scheduleSave();
  });

  hiddenCheck.addEventListener('change', () => {
    pushHistory();
    annotation.hidden = hiddenCheck.checked;
    applyLayerVisibility();
    scheduleSave();
  });

  document.getElementById('edit-layer')?.addEventListener('change', (e) => {
    moveToLayer(type, annotation, e.target.value);
    renderDetailPanel(); // parent options depend on the layer
  });

  document.getElementById('edit-parent')?.addEventListener('change', (e) => {
    pushHistory();
    const v = e.target.value;
    if (v === '') {
      annotation.parentManual = false;
      renest([annotation]);
    } else {
      annotation.parentManual = true;
      annotation.parentId     = v === '__none' ? null : v;
    }
    scheduleSave();
    renderDetailTree(annotation);
  });

  if (isRegion) bindSwatchGrid(annotation);

  document.getElementById('edit-delete').addEventListener('click', () => {
    deleteAnnotation(type, annotation.id);
  });

  document.getElementById('edit-merge')?.addEventListener('click', () => {
    startMerge(annotation.id);
  });

  document.getElementById('edit-merge-cancel')?.addEventListener('click', cancelMerge);

  document.getElementById('edit-consolidate')?.addEventListener('click', () => {
    consolidateRegion(annotation.id);
  });

  bindBackButton();
  labelInput.focus();
  labelInput.select();
}

function treeLinkHtml(type, item) {
  const dot = type === 'region'
    ? `<span class="color-wheel" style="background:${escapeHtml(item.color || '#4a9eff')}"></span>` : '';
  const fallback = type === 'region' ? 'Untitled region' : 'Untitled pin';
  return `<span class="tree-link" data-type="${type}" data-id="${escapeHtml(item.id)}">${dot}${escapeHtml(item.label || fallback)}</span>`;
}

// regions expand in place (<details>) when they have children of their own
function childNodesHtml(kids, seen) {
  const regionHtml = kids.regions.map(r => {
    const sub   = childrenInView(r.id);
    const count = seen.has(r.id) ? 0 : countInView(sub);
    if (!count) return `<div class="tree-leaf">${treeLinkHtml('region', r)}</div>`;
    return `
      <details class="tree-node">
        <summary>${treeLinkHtml('region', r)} <span class="tree-count">${count}</span></summary>
        <div class="tree-children">${childNodesHtml(sub, new Set([...seen, r.id]))}</div>
      </details>`;
  }).join('');
  const pinHtml = kids.pins
    .map(p => `<div class="tree-leaf tree-pin">${treeLinkHtml('pin', p)}</div>`).join('');
  return regionHtml + pinHtml;
}

function renderTreeHtml(item) {
  const crumbs = ancestorsOf(item).filter(visibleInMode);
  const crumbHtml = crumbs.length
    ? `<div class="tree-crumbs">${crumbs.map(a => treeLinkHtml('region', a)).join('<span class="tree-sep">›</span>')}</div>`
    : '';
  const kids  = item.polygons ? childrenInView(item.id) : { regions: [], pins: [] };
  const count = countInView(kids);
  const kidsHtml = count ? `
    <details class="pin-list" open>
      <summary class="pin-list-summary">Contains (${count})</summary>
      <div class="tree-children">${childNodesHtml(kids, new Set([item.id]))}</div>
    </details>` : '';
  return crumbHtml + kidsHtml;
}

function renderDetailTree(item) {
  if (!detailTree) return;
  const html = item ? renderTreeHtml(item) : '';
  detailTree.innerHTML = html;
  detailTree.classList.toggle('hidden', !html);
  detailTree.querySelectorAll('.tree-link').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault(); // don't toggle the <details> the link sits in
      e.stopPropagation();
      const { type, id } = el.dataset;
      if (!findAnnotation(type, id)) return;
      navigateAnnotation(type, id);
      panToItem(type, id);
    });
  });
}

// refresh nesting views after links change, without re-rendering (and refocusing) the editor
export function refreshTree() {
  const sel = state.ui.selected;
  if (sel) renderDetailTree(findAnnotation(sel.type, sel.id));
  else refreshLayerList();
}
