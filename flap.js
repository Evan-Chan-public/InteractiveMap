// FLAP — the vellum flap that folds out of the tool roll: the tool in hand (or the map file), how to
// use it on what's selected now, its settings and its keys. Rebuilt whenever the tool, the selection
// or the layer changes

import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { findAnnotation } from './nesting.js';

const flap      = document.getElementById('tool-flap');
const flapTitle = document.getElementById('flap-title');
const flapHowto = document.getElementById('flap-howto');
const flapKeys  = document.getElementById('flap-keys');
const flapDone  = document.getElementById('flap-done');
const flapFold  = document.getElementById('flap-fold');
const parts = {
  wand:  document.getElementById('wand-options'),
  brush: document.getElementById('brush-controls'),
  map:   document.getElementById('map-sheet'),
};

// the map file shares the flap with the tools; only one is open at a time
let mapOpen = false;

export function isMapOpen() { return mapOpen; }
export function setMapOpen(open) { mapOpen = open; renderFlap(); }

// a tool's flap folds down to a slim tab to free the map's corner; the tool stays in hand, and
// the next tool's flap opens folded too, until it's unfolded
let folded = false;

export function isFolded() { return folded; }
export function setFolded(fold) { folded = fold; renderFlap(); }

const b = (s) => `<b>${escapeHtml(s)}</b>`;

// keys get a plate; the gestures around them ("Click a corner", "-drag") are written out
const keyHtml = (k) => escapeHtml(k).replace(/\b(Esc|Shift)\b|\[|\]/g, '<kbd>$&</kbd>');

// Esc unwinds from the inside out: a selection is let go first, then the tool is put down
function escKeys() {
  return state.ui.selected ? [['Esc', 'let go of the selection'], ['Esc again', 'put the tool down']]
                           : [['Esc', 'put the tool down']];
}

const SIZE_KEYS = ['[ ]', 'shrink or grow it'];

function selectedRegion() {
  const sel = state.ui.selected;
  return sel?.type === 'region' ? findAnnotation('region', sel.id) : null;
}

function layerName() {
  const layer = state.annotations.layers.find(l => l.id === state.ui.activeLayerId);
  return layer?.name || 'this layer';
}

// title, a line on how to use it here, and the keys that change what it does
const TOOLS = {
  pin: () => ({
    title: 'Add Pin',
    howto: `Click the map to place a pin on ${b(layerName())}.`,
    keys: escKeys(),
  }),
  region: () => ({
    title: 'Add Region',
    howto: `Click to set each corner of a region on ${b(layerName())}; click the first corner again, or double-click, to close it.`,
    keys: [['Esc', 'cancel the shape, then put the tool down']],
  }),
  wand: () => ({
    title: 'Flood Region',
    howto: `Click inside an outlined area of the image to fill it as a region on ${b(layerName())}.`,
    keys: escKeys(),
    part: 'wand',
  }),
  edit: () => {
    const region = selectedRegion();
    return {
      title: 'Edit Vertices',
      howto: region ? `Drag a corner of ${b(region.label || 'the region')} to move it.` : 'Click a region to show its corners.',
      keys: [['Click a corner', 'remove it'], ['Click a midpoint', 'add a corner'], ['Esc', 'put the tool down']],
    };
  },
  brush: () => {
    const region = selectedRegion();
    return {
      title: 'Brush',
      howto: region ? `Drag over the map to paint onto ${b(region.label || 'the region')}.`
                    : `Drag over the map to paint a new region on ${b(layerName())}.`,
      keys: [['Shift-drag', 'start a new region'], SIZE_KEYS, ...escKeys()],
      part: 'brush',
    };
  },
  eraser: () => ({
    title: 'Eraser',
    howto: `Drag over the map to rub out regions on ${b(layerName())}.`,
    keys: [SIZE_KEYS, ...escKeys()],
    part: 'brush',
  }),
};

// a folded flap is a strip lettered with the tool's name; anywhere on it unfolds it
flap.addEventListener('click', (e) => {
  if (flap.classList.contains('is-folded') && !e.target.closest('button')) setFolded(false);
});

export function renderFlap() {
  const tool = state.mode === 'design' ? state.ui.activeTool : null;
  const open = (tool && TOOLS[tool]) || (state.mode === 'design' && mapOpen);
  flap.classList.toggle('hidden', !open);
  document.body.classList.toggle('flap-open', !!open);
  document.body.classList.toggle('flap-folded', !!open && !!tool && folded);
  if (!open) return;

  const tucked = !!tool && folded; // the map file's flap has Done instead
  flap.classList.toggle('is-folded', tucked);
  flapFold.classList.toggle('hidden', !tool);
  flapFold.setAttribute('aria-expanded', !tucked);
  flapFold.setAttribute('aria-label', tucked ? 'Unfold the flap' : 'Fold the flap away (the tool stays in hand)');
  flapFold.title = tucked ? 'Unfold' : 'Fold away: the tool stays in hand';

  const spec = tool ? TOOLS[tool]() : { title: 'Map', howto: '', keys: [], part: 'map' };
  flapTitle.textContent = spec.title;
  flapHowto.innerHTML = spec.howto;
  flapHowto.classList.toggle('hidden', !spec.howto);
  for (const [name, el] of Object.entries(parts)) el.classList.toggle('hidden', spec.part !== name);
  flapKeys.innerHTML = spec.keys.map(([k, what]) => `<dt>${keyHtml(k)}</dt><dd>${escapeHtml(what)}</dd>`).join('');
  flapKeys.classList.toggle('hidden', !spec.keys.length);
  flapDone.textContent = tool ? 'Put down' : 'Done';
}
