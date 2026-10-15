// PANEL — the right panel: layer list, details view, editor, nesting tree, merge preview

import { navStack, state } from './state.js';
import { DEFAULT_MARK, DEFAULT_REGION_COLOR, escapeHtml, ICON_EYE, ICON_EYE_OFF, ICON_LEFT, ICON_PIPETTE, ICON_RIGHT, markSvg,
         pigmentName, PIGMENTS, PIN_MARKS } from './utils.js';
import { scheduleSave } from './persistence.js';
import { ancestorsOf, autoParent, childrenInView, countInView, findAnnotation, findItem,
         renest, renestAll, visibleInMode, wouldCycle } from './nesting.js';
import { map } from './map.js';
import { pushHistory } from './history.js';
import { clearSelection, goBack, navigateAnnotation, panToItem, selectAnnotation, showLayer } from './selection.js';
import { applyLayerVisibility, hiddenInView, toggleItemView, updatePinLayer, updateRegionLayer } from './render.js';
import { moveLayer, moveToLayer } from './layerstrip.js';
import { isDeleteArmed, requestDelete } from './create.js';
import { cancelMerge, consolidateRegion, startMerge } from './shapes.js';
import { renderFlap } from './flap.js';

// DOM

const detailPanel      = document.getElementById('detail-panel');
const detailHeading    = document.getElementById('detail-heading');
const detailClose      = document.getElementById('detail-close');
const detailContent    = document.getElementById('detail-content');
const detailTree       = document.getElementById('detail-tree');
const detailTrail      = document.getElementById('detail-trail');

// SWATCHES — the pigment box, plus a custom colour

function renderSwatchGrid(currentColor) {
  const cur = (currentColor || DEFAULT_REGION_COLOR).toLowerCase();
  const inPreset = !!pigmentName(cur);
  const swatches = PIGMENTS.map(({ name, color }) => {
    const active = color === cur;
    return `<button type="button" class="swatch${active ? ' active' : ''}" style="background:${color}" data-color="${color}"
                    title="${name}" aria-label="${name}" aria-pressed="${active}"></button>`;
  }).join('');
  return `
    <div id="swatch-grid" class="swatch-grid">
      ${swatches}
      <button type="button" class="swatch swatch-custom${!inPreset ? ' active' : ''}" id="swatch-custom-btn"
              title="Custom colour" aria-label="Custom colour" aria-pressed="${!inPreset}">${ICON_PIPETTE}</button>
    </div>
    <input id="edit-color-custom" type="color" value="${escapeHtml(currentColor || DEFAULT_REGION_COLOR)}" hidden />
  `;
}

// a radio group: one tab stop, arrow keys move the choice
function bindMarkPicker(pin) {
  const picker  = document.getElementById('mark-picker');
  const options = [...picker.querySelectorAll('.mark-option')];
  const choose  = (option) => {
    if (option.dataset.mark === (pin.mark ?? DEFAULT_MARK)) return;
    pushHistory();
    pin.mark = option.dataset.mark;
    options.forEach(o => {
      o.classList.toggle('active', o === option);
      o.setAttribute('aria-checked', o === option);
      o.tabIndex = o === option ? 0 : -1;
    });
    updatePinLayer(pin);
    scheduleSave();
  };
  picker.addEventListener('click', (e) => {
    const option = e.target.closest('[data-mark]');
    if (option) choose(option);
  });
  picker.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = options[(options.indexOf(document.activeElement) + step + options.length) % options.length];
    next.focus();
    choose(next);
  });
}

function bindSwatchGrid(annotation) {
  const grid        = document.getElementById('swatch-grid');
  const customBtn   = document.getElementById('swatch-custom-btn');
  const customInput = document.getElementById('edit-color-custom');
  const colorDot    = document.querySelector('.swatch-summary .color-dot');
  const colorName   = document.querySelector('.swatch-summary .swatch-name');
  const syncDot     = (c) => {
    if (colorDot) colorDot.style.background = c;
    if (colorName) colorName.textContent = pigmentName(c) ?? 'Custom';
  };
  const markActive  = (btn) => grid.querySelectorAll('.swatch').forEach(s => {
    s.classList.toggle('active', s === btn);
    s.setAttribute('aria-pressed', s === btn);
  });

  grid.addEventListener('click', (e) => {
    const swatch = e.target.closest('[data-color]');
    if (!swatch) return;
    pushHistory();
    annotation.color = swatch.dataset.color;
    customInput.value = annotation.color;
    syncDot(annotation.color);
    markActive(swatch);
    updateRegionLayer(annotation);
    scheduleSave();
  });

  customBtn.addEventListener('click', () => customInput.click());

  customInput.addEventListener('focus', () => { pushHistory(); });
  customInput.addEventListener('input', (e) => {
    annotation.color = e.target.value;
    syncDot(annotation.color);
    markActive(customBtn);
    updateRegionLayer(annotation);
    scheduleSave();
  });
}

// DETAIL PANEL

export function renderDetailPanel() {
  const sel = state.ui.selected;
  renderFlap(); // the flap names the selected region

  if (state.ui.mergeSource && state.ui.mergeHover
      && state.ui.mergeSource !== state.ui.mergeHover) {
    const source = findAnnotation('region', state.ui.mergeSource);
    const target = findAnnotation('region', state.ui.mergeHover);
    if (source && target) { renderDetailTree(null); renderMergePreview(source, target); return; }
  }

  setPanelVisible(!!sel || showsLayerList());
  detailHeading.textContent = sel ? 'Details' : 'Layer';
  detailPanel.classList.toggle('is-list', !sel);
  detailClose.classList.toggle('hidden', !sel);

  if (!sel) {
    renderDetailTree(null);
    if (showsLayerList()) renderLayerList();
    else detailContent.innerHTML = '<p class="detail-empty">Click a region or pin to see details.</p>';
    return;
  }

  const annotation = findAnnotation(sel.type, sel.id);
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

// closing the leaf: display leaves the drill-down for the outermost layer, as a click outside does
export function closeDetails() {
  if (state.mode === 'display' && state.annotations.layers.length) showLayer(state.annotations.layers[0].id);
  clearSelection();
}

detailClose.addEventListener('click', closeDetails);

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

  const row = (type, a) => {
    const name   = a.label || (type === 'region' ? 'Untitled region' : 'Untitled pin');
    const hidden = hiddenInView(a);
    return `
    <div class="pin-list-item item-row${a.hidden ? ' item-hidden' : ''}${hidden ? ' view-hidden' : ''}" data-type="${type}" data-id="${escapeHtml(a.id)}">
      <button type="button" class="item-row-main">
        ${type === 'region' ? `<span class="color-wheel" style="background:${escapeHtml(a.color || DEFAULT_REGION_COLOR)}"></span>` : `<span class="row-mark">${markSvg(a.mark, 12)}</span>`}
        <span class="item-row-label">${escapeHtml(name)}</span>
        ${a.parentId ? `<span class="item-row-parent">in ${escapeHtml(findItem(a.parentId)?.label || 'Untitled')}</span>` : ''}
      </button>
      <button type="button" class="row-eye" aria-pressed="${hidden}" aria-label="${hidden ? 'Show' : 'Hide'} ${escapeHtml(name)} while editing"
              title="${hidden ? 'Show' : 'Hide while editing (not saved; viewers still see it)'}">${hidden ? ICON_EYE_OFF : ICON_EYE}</button>
    </div>`;
  };
  const section = (title, type, items) => items.length ? `
    <details class="pin-list" open>
      <summary class="pin-list-summary">${title} (${items.length})</summary>
      ${items.map(a => row(type, a)).join('')}
    </details>` : '';

  const sections = section('Regions', 'region', regions) + section('Pins', 'pin', pins);
  const index    = state.annotations.layers.indexOf(layer);
  const last     = state.annotations.layers.length - 1;
  const layerName = escapeHtml(layer?.name || 'Layer');
  detailContent.innerHTML = `
    <div class="layer-tools">
      <h2 class="detail-title">${layerName}</h2>
      ${last > 0 ? `
      <div class="layer-move" role="group" aria-label="Layer order">
        <button type="button" id="layer-move-left" aria-label="Move ${layerName} left (lower)" title="Move left (lower) · Alt+←" ${index <= 0 ? 'disabled' : ''}>${ICON_LEFT}</button>
        <button type="button" id="layer-move-right" aria-label="Move ${layerName} right (higher)" title="Move right (higher) · Alt+→" ${index >= last ? 'disabled' : ''}>${ICON_RIGHT}</button>
      </div>` : ''}
    </div>
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
  // the list re-renders after a move: keep the keyboard on the move buttons
  const bindMove = (btnId, step) => document.getElementById(btnId)?.addEventListener('click', () => {
    moveLayer(layer.id, step);
    const again = document.getElementById(btnId);
    (again?.disabled ? document.getElementById(step < 0 ? 'layer-move-right' : 'layer-move-left') : again)?.focus();
  });
  bindMove('layer-move-left', -1);
  bindMove('layer-move-right', 1);

  detailContent.querySelectorAll('.item-row').forEach(el => {
    el.addEventListener('click', (e) => {
      const { type, id } = el.dataset;
      if (e.target.closest('.row-eye')) {
        const refocus = e.target.closest('.row-eye') === document.activeElement;
        toggleItemView(id); // re-renders the list: keep the keyboard where it was
        if (refocus) detailContent.querySelector(`.item-row[data-id="${CSS.escape(id)}"] .row-eye`)?.focus();
        return;
      }
      selectAnnotation(type, id);
      panToItem(type, id);
    });
  });
}

// descriptions can arrive in share links: markdown output is sanitized, or shown as plain text
function bodyHtml(body) {
  if (!body) return '<p class="detail-empty-body"><em>No description.</em></p>';
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return escapeHtml(body);
  return DOMPurify.sanitize(marked.parse(body));
}

function renderMergePreview(source, target) {
  detailContent.innerHTML = `
    <div class="merge-banner">
      Click to merge into
      <span class="color-wheel" style="background:${escapeHtml(source.color || DEFAULT_REGION_COLOR)}"></span>
      <strong>${escapeHtml(source.label || 'Untitled')}</strong>
    </div>
    <h2 class="merge-target-title">
      <span class="color-wheel" style="background:${escapeHtml(target.color || DEFAULT_REGION_COLOR)}"></span>
      ${escapeHtml(target.label || 'Untitled')}
    </h2>
    <div class="detail-body markdown-body">${bodyHtml(target.body)}</div>
  `;
}

function backButtonHtml() {
  if (!navStack.length && state.mode === 'display') return ''; // the trail in the header leads back out
  if (!navStack.length) {
    if (!showsLayerList()) return '';
    const layer = state.annotations.layers.find(l => l.id === state.ui.activeLayerId);
    return `<button id="nav-back" class="btn-back">${ICON_LEFT}${escapeHtml(layer?.name || 'Layer')}</button>`;
  }
  const prev = navStack[navStack.length - 1];
  const label = findAnnotation(prev.type, prev.id)?.label || 'Untitled';
  return `<button id="nav-back" class="btn-back">${ICON_LEFT}${escapeHtml(label)}</button>`;
}

function bindBackButton() {
  document.getElementById('nav-back')?.addEventListener('click', goBack);
}

function renderDetailView(annotation) {
  detailContent.innerHTML = `
    <div class="detail-view">
      ${backButtonHtml()}
      <h2 class="detail-title">${escapeHtml(annotation.label || 'Untitled')}</h2>
      <hr class="detail-divider" />
      <div class="detail-body markdown-body">${bodyHtml(annotation.body)}</div>
    </div>
  `;
  bindBackButton();
  illuminate(detailContent.querySelector('.detail-view .markdown-body > p:first-child'));
}

// the note opens with an illuminated initial: dropped through two lines when the first paragraph
// runs that long, otherwise enlarged in line (a one-line note would leave a dropped letter hanging)
function illuminate(p) {
  if (!p || p.classList.contains('detail-empty-body') || !/^\p{L}/u.test(p.textContent.trimStart())) return;
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode()) && !/\p{L}/u.test(node.data));
  const m = node?.data.match(/\p{L}/u);
  if (!m) return;
  const letter = node.splitText(m.index);
  letter.splitText(m[0].length);
  const initial = document.createElement('span');
  initial.className = 'initial';
  letter.replaceWith(initial);
  initial.append(letter);
  const lines = p.offsetHeight / parseFloat(getComputedStyle(p).lineHeight);
  initial.classList.add(lines >= 1.9 ? 'initial-drop' : 'initial-inline');
}

function renderDetailEditor(annotation, type) {
  const isRegion = type === 'region';

  const colorSwatch = isRegion ? `
    <details class="swatch-details">
      <summary class="swatch-summary">
        <span class="field-label" style="display:inline">Color</span>
        <span class="color-dot" style="background:${escapeHtml(annotation.color || DEFAULT_REGION_COLOR)}"></span>
        <span class="swatch-name">${pigmentName(annotation.color || DEFAULT_REGION_COLOR) ?? 'Custom'}</span>
      </summary>
      ${renderSwatchGrid(annotation.color)}
    </details>` : '';

  const mark       = annotation.mark ?? DEFAULT_MARK;
  const markPicker = isRegion ? '' : `
    <span class="field-label">Mark</span>
    <div id="mark-picker" class="mark-picker" role="radiogroup" aria-label="Mark">
      ${Object.entries(PIN_MARKS).map(([key, m]) => `
        <button class="mark-option${mark === key ? ' active' : ''}" data-mark="${key}" tabindex="${mark === key ? 0 : -1}"
                role="radio" aria-checked="${mark === key}" aria-label="${m.title}" title="${m.title}">${markSvg(key, 16)}</button>`).join('')}
    </div>`;

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

  const deleteBtn = isDeleteArmed(annotation.id)
    ? '<button id="edit-delete" class="btn-danger armed" title="Delete (Backspace)">Confirm delete</button>'
    : '<button id="edit-delete" class="btn-danger" title="Delete (Backspace)">Delete</button>';
  const actionBtns = isRegion ? `
    <button id="edit-merge" class="btn-secondary">Merge…</button>
    ${polyCount > 1 ? `<button id="edit-consolidate" class="btn-secondary">Consolidate</button>` : ''}
    ${deleteBtn}
  ` : deleteBtn;

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
      ${markPicker}
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
  else bindMarkPicker(annotation);

  document.getElementById('edit-delete').addEventListener('click', () => {
    requestDelete(type, annotation.id);
  });

  document.getElementById('edit-merge')?.addEventListener('click', () => {
    startMerge(annotation.id);
  });

  document.getElementById('edit-merge-cancel')?.addEventListener('click', cancelMerge);

  document.getElementById('edit-consolidate')?.addEventListener('click', () => {
    consolidateRegion(annotation.id);
  });

  bindBackButton();
  if (focusLabelFor === annotation.id) {
    focusLabelFor = null;
    labelInput.focus();
    labelInput.select();
  }
}

// only new items take focus: on an existing selection, Backspace deletes instead of editing the label
let focusLabelFor = null;

export function focusLabelOnce(id) {
  focusLabelFor = id;
}

export function showDeleteArmed(on) {
  const btn = document.getElementById('edit-delete');
  if (!btn) return;
  btn.classList.toggle('armed', on);
  btn.textContent = on ? 'Confirm delete' : 'Delete';
}

function treeLinkHtml(type, item) {
  const dot = type === 'region'
    ? `<span class="color-wheel" style="background:${escapeHtml(item.color || DEFAULT_REGION_COLOR)}"></span>`
    : `<span class="row-mark">${markSvg(item.mark, 12)}</span>`;
  const fallback = type === 'region' ? 'Untitled region' : 'Untitled pin';
  return `<button type="button" class="tree-link" data-type="${type}" data-id="${escapeHtml(item.id)}">${dot}${escapeHtml(item.label || fallback)}</button>`;
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
    ? `${ICON_LEFT}${crumbs.map(a => treeLinkHtml('region', a)).join('<span class="tree-sep" aria-hidden="true">›</span>')}`
    : '';
  const kids  = item.polygons ? childrenInView(item.id) : { regions: [], pins: [] };
  const count = countInView(kids);
  const kidsHtml = count ? `
    <details class="pin-list" open>
      <summary class="pin-list-summary">Contains (${count})</summary>
      <div class="tree-children">${childNodesHtml(kids, new Set([item.id]))}</div>
    </details>` : '';
  return { crumbHtml, kidsHtml };
}

// the trail of places this sits in heads the leaf; what it contains opens below
function renderDetailTree(item) {
  if (!detailTree) return;
  const { crumbHtml, kidsHtml } = item ? renderTreeHtml(item) : { crumbHtml: '', kidsHtml: '' };
  detailTree.innerHTML = kidsHtml;
  detailTree.classList.toggle('hidden', !kidsHtml);
  detailTrail.innerHTML = crumbHtml;
  detailTrail.classList.toggle('hidden', !crumbHtml);
  [...detailTree.querySelectorAll('.tree-link'), ...detailTrail.querySelectorAll('.tree-link')].forEach(el => {
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
