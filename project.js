// PROJECT — the map as one document: the .imap.json file format, opening and replacing the
// current map, export / import, drag-and-drop, and keeping a map that was opened from a link
//
// file: { format, version, title, modified, image, annotations }
//   image: { width, height, name, data: 'data:image/…;base64,…' }   embedded (the default)
//        | { width, height, src: 'maps/world.png' }                  bundled map, by reference
//        | null                                                      the viewer's baseline map

import { state, navStack } from './state.js';
import { clearSaved, ensureLayers, loadSaved, sanitizeAnnotations, saveNow, scheduleSave } from './persistence.js';
import { ensureNesting } from './nesting.js';
import { resetHistory } from './history.js';
import { mountAll, unmountAll } from './render.js';
import { renderDetailPanel } from './panel.js';
import { renderLayerStrip } from './layerstrip.js';
import { cancelRegionDraw, disarmDelete, seedColors } from './create.js';
import { cancelWand } from './wand.js';
import { appUrl } from './share.js';
import { cancelMerge, exitVertexEdit } from './shapes.js';
import { imageRecord, loadBaseline, loadImageFile, mapParam, showImage, updatePlaceholder } from './image.js';

export const FORMAT  = 'interactive-map';
export const VERSION = 1;

// DOM

const titleInput   = document.getElementById('project-title');
const btnExport    = document.getElementById('project-export');
const btnImport    = document.getElementById('project-import');
const importInput  = document.getElementById('project-input');
const statusEl     = document.getElementById('project-status');
const linkNotice   = document.getElementById('link-notice');
const btnKeep      = document.getElementById('keep-map');
const dialog       = document.getElementById('confirm-dialog');
const mapContainer = document.getElementById('map-container');

// FORMAT

// older versions are upgraded step by step on load: MIGRATIONS[n] turns a version n file into n + 1
const MIGRATIONS = {};

const IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
const IMAGE_SRC  = /^(https?:\/\/|(?![a-z][\w+.-]*:))[^\s"'<>]+$/i; // http(s) or a relative path: no other schemes

// a project object (from a file, a link or storage) → { title, image, annotations }. throws on bad input
export async function parseProject(obj) {
  if (!obj || typeof obj !== 'object' || obj.format !== FORMAT) throw new Error('not an Interactive Map project file');
  let version = obj.version;
  if (!Number.isInteger(version) || version < 1) throw new Error('the file has no valid format version');
  if (version > VERSION) throw new Error(`made by a newer version of the app (format ${version}); update to open it`);
  for (; version < VERSION; version++) obj = MIGRATIONS[version](obj);

  if (!obj.annotations || typeof obj.annotations !== 'object') throw new Error('no annotations in the file');
  return {
    title:       typeof obj.title === 'string' ? obj.title.slice(0, 200) : '',
    image:       await parseImage(obj.image),
    annotations: sanitizeAnnotations(obj.annotations),
  };
}

// → a showImage source, or null (use the baseline)
async function parseImage(img) {
  if (!img || typeof img !== 'object') return null;
  const name = typeof img.name === 'string' ? img.name.slice(0, 200) : 'map';
  if (img.blob instanceof Blob) return { kind: 'blob', blob: img.blob, name };       // from IndexedDB
  if (typeof img.data === 'string') {
    if (!IMAGE_DATA.test(img.data)) throw new Error('the embedded image is not a PNG, JPEG, GIF or WebP');
    const blob = await (await fetch(img.data)).blob();
    return { kind: 'blob', blob, name };
  }
  if (typeof img.src === 'string' && IMAGE_SRC.test(img.src)) return { kind: 'ref', src: img.src };
  return null;
}

// the current map as a file object, image embedded
async function buildProjectFile() {
  return {
    format:      FORMAT,
    version:     VERSION,
    title:       state.title,
    modified:    new Date().toISOString(),
    image:       await imageRecord({ forFile: true }),
    annotations: state.annotations,
  };
}

// readable JSON that stays compact: one { lat, lng } point per line
function formatJson(obj) {
  return JSON.stringify(obj, null, 2)
    .replace(/\{\n\s+"lat": ([^,\n]+),\n\s+"lng": ([^\n]+)\n\s+\}/g, '{ "lat": $1, "lng": $2 }');
}

// the saved map couldn't be read: this session doesn't save (and isn't a link session either)
let savedUnreadable = false;

const emptyDocument = () => ({ title: '', image: null, annotations: { layers: [], regions: [], pins: [] } });

// OPEN

// replace the current map with doc ({ title, image, annotations }, already parsed).
// autosave: false for maps opened from a link, until they're kept.
// useMapParam: an explicit ?map= beats the doc's own image (startup only; an imported file keeps its image)
export async function openDocument(doc, { autosave = true, locked = false, useMapParam = false } = {}) {
  exitVertexEdit();
  cancelRegionDraw();
  cancelMerge();
  cancelWand();    // a fill traced from the old image must not land on the new map
  disarmDelete();
  unmountAll();

  state.title             = doc.title || '';
  state.docImage          = doc.image ?? null;
  state.annotations       = doc.annotations;
  state.ui.autosave       = autosave;
  state.ui.shareLocked    = locked;
  state.ui.selected       = null;
  navStack.length         = 0;
  ensureLayers(state.annotations);
  ensureNesting();
  seedColors(state.annotations.regions.length);
  state.ui.activeLayerId  = state.annotations.layers[0].id;
  resetHistory();

  renderLayerStrip();
  mountAll();
  renderProjectPanel();

  // the doc's own image, falling back to the baseline. Either way doc.image stays the map's image
  // (state.docImage), so a fallback or override is never saved over it
  const own    = doc.image && !(useMapParam && mapParam);
  const result = own ? await showImage(doc.image) : 'failed';
  if (result === 'failed') {
    if (own) setStatus('The map image could not be loaded; showing the baseline map for now.', true);
    await loadBaseline();
  }
  updatePlaceholder();
  renderDetailPanel();
}

// the saved map, or an empty one. A saved map that can't be read is left untouched: the session
// opens empty and doesn't autosave over it
export async function openSaved() {
  const saved = await loadSaved();
  if (!saved) { await openDocument(emptyDocument(), { autosave: true, useMapParam: true }); return; }
  try {
    const doc = await parseProject({ format: FORMAT, version: VERSION, ...saved });
    await openDocument(doc, { autosave: true, useMapParam: true });
  } catch (err) {
    console.warn('Saved map could not be read:', err);
    savedUnreadable = true;
    await openDocument(emptyDocument(), { autosave: false, useMapParam: true });
    setStatus("Your saved map couldn't be read, so it's left as it is and this session won't save. Importing a map replaces it.", true);
  }
}

export async function discardSaved({ ask: confirmFirst = false } = {}) {
  if (confirmFirst) {
    const choice = await ask('Discard the saved map?', 'Its annotations and image are deleted from this browser. This can’t be undone.', [
      { value: 'replace', label: 'Discard', danger: true },
      { value: 'cancel',  label: 'Cancel' },
    ]);
    if (choice !== 'replace') return;
  }
  await clearSaved();
  await openDocument(emptyDocument(), { autosave: true });
  setStatus('Saved map discarded.');
}

const hasContent = () => state.annotations.regions.length > 0 || state.annotations.pins.length > 0;

// EXPORT

async function exportFile() {
  setStatus('Preparing file…');
  const text = formatJson(await buildProjectFile());
  const url  = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a    = document.createElement('a');
  a.href     = url;
  a.download = fileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  setStatus(`Exported ${a.download} (${(text.length / 1024 / 1024).toFixed(1)} MB).`);
}

function fileName() {
  const slug = state.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug || 'map'}.imap.json`;
}

// IMPORT

export async function importFile(file) {
  if (state.ui.shareLocked) return;
  let doc;
  try {
    doc = await parseProject(JSON.parse(await file.text()));
  } catch (err) {
    setStatus(`Couldn't open ${file.name}: ${err instanceof SyntaxError ? 'not valid JSON' : err.message}.`, true);
    return;
  }
  const choice = await confirmReplace(`Open “${doc.title || file.name}”?`);
  if (choice === 'cancel') return;
  if (choice === 'export') await exportFile();
  savedUnreadable = false;
  await openDocument(doc, { autosave: true });
  forgetLinkInAddress();
  scheduleSave({ image: true });
  if (await saveNow()) setStatus(`Opened ${file.name}.`);
}

// replacing the saved map can't be undone: offer to export it first
async function confirmReplace(question) {
  // a linked map is on screen: the saved one it would replace isn't, so always ask
  if (state.ui.autosave && !hasContent() && !state.docImage) return 'replace';
  const saved = state.ui.autosave ? 'your current map' : 'your saved map (if you have one)';
  return ask(question, `This replaces ${saved}, and it can't be undone.`, [
    ...(state.ui.autosave ? [{ value: 'export', label: 'Export current first' }] : []),
    { value: 'replace', label: 'Replace', danger: true },
    { value: 'cancel',  label: 'Cancel' },
  ]);
}

// KEEPING A LINKED MAP

async function keepMap() {
  const choice = await ask('Keep this map?', 'It becomes your saved map and replaces the one saved in this browser, if any.', [
    { value: 'replace', label: 'Keep it', danger: true },
    { value: 'cancel',  label: 'Cancel' },
  ]);
  if (choice !== 'replace') return;
  state.ui.autosave = true;
  forgetLinkInAddress();
  scheduleSave({ image: true });
  const ok = await saveNow();
  renderProjectPanel();
  if (ok) setStatus('Saved as your map.');
}

// once a linked map is kept (or replaced by an import), reloading must open the saved map, not the link
function forgetLinkInAddress() {
  history.replaceState(null, '', appUrl());
}

// UI

export function renderProjectPanel() {
  if (titleInput && document.activeElement !== titleInput) titleInput.value = state.title;
  linkNotice?.classList.toggle('hidden', state.ui.autosave || savedUnreadable);
  document.title = state.title ? `${state.title} · Interactive Map` : 'Interactive Map';
}

export function setStatus(message, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

document.addEventListener('savestatus', (e) => {
  if (e.detail.status === 'error') setStatus(`Not saved: ${e.detail.message}.`, true);
  else if (statusEl?.classList.contains('error') && statusEl.textContent.startsWith('Not saved')) setStatus('');
});

titleInput?.addEventListener('input', () => {
  state.title = titleInput.value;
  document.title = state.title ? `${state.title} · Interactive Map` : 'Interactive Map';
  scheduleSave();
});

btnExport?.addEventListener('click', exportFile);
btnImport?.addEventListener('click', () => importInput.click());
importInput?.addEventListener('change', () => {
  const file = importInput.files[0];
  importInput.value = '';
  if (file) importFile(file);
});
btnKeep?.addEventListener('click', keepMap);

// drop a project file anywhere on the map to open it, or an image (Design Mode) to use it as the map
const droppedFile = (e) => [...(e.dataTransfer?.files ?? [])][0];
mapContainer?.addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault();
});
mapContainer?.addEventListener('drop', (e) => {
  const file = droppedFile(e);
  if (!file) return;
  e.preventDefault();
  if (file.type.startsWith('image/')) {
    if (state.mode === 'design') loadImageFile(file);
  } else if (file.name.endsWith('.json') || file.type === 'application/json') {
    importFile(file);
  }
});

// a small modal: resolves with the clicked button's value ('cancel' on Esc)
function ask(title, message, buttons) {
  if (!dialog?.showModal) return Promise.resolve(window.confirm(`${title}\n\n${message}`) ? 'replace' : 'cancel');
  dialog.querySelector('.dialog-title').textContent   = title;
  dialog.querySelector('.dialog-message').textContent = message;
  const row = dialog.querySelector('.dialog-buttons');
  row.innerHTML = '';
  return new Promise(resolve => {
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className   = b.danger ? 'btn-danger armed' : 'btn-secondary';
      btn.textContent = b.label;
      btn.addEventListener('click', () => { dialog.close(b.value); });
      if (b.value === 'cancel') btn.autofocus = true; // Enter must not confirm a replace by accident
      row.appendChild(btn);
    }
    dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true });
    dialog.returnValue = '';
    dialog.showModal();
  });
}

