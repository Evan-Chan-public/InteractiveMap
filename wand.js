// WAND — flood-fill regions: the WASM worker, its progress ticker, and turning results into regions

import { state } from './state.js';
import { generateId } from './utils.js';
import { scheduleSave } from './persistence.js';
import { renestAround } from './nesting.js';
import { pushHistory } from './history.js';
import { selectAnnotation } from './selection.js';
import { mountRegionLayer } from './render.js';
import { nextColor } from './create.js';

// DOM

const wandStatus       = document.getElementById('wand-status');
const wandTolerance    = document.getElementById('wand-tolerance');
const wandToleranceVal = document.getElementById('wand-tolerance-val');
const btnWandCancel    = document.getElementById('wand-cancel');

// WASM WORKER

const WINDOW = 1024;

let worker      = null;
let workerReady = false;
let wandPending = false;
let wandOffset  = { x: 0, y: 0 };
let wandStage   = '';
let wandStart   = 0;
let wandTicker  = null;

export function initWorker() {
  worker = new Worker('./worker.js');
  worker.onmessage = (e) => {
    const msg = e.data;
    if      (msg.type === 'ready')    { workerReady = true; }
    else if (msg.type === 'progress') { wandStage = msg.stage; updateWandTicker(msg); }
    else if (msg.type === 'result')   { stopWandTicker(); onWandResult(msg); }
    else if (msg.type === 'empty')    {
      stopWandTicker(); wandPending = false;
      setWandStatus('No fill — try adjusting tolerance or clicking a different spot.');
    }
    else if (msg.type === 'error')    {
      stopWandTicker(); wandPending = false;
      setWandStatus('Error: ' + msg.reason);
    }
  };
}

function startWandTicker() {
  wandStart  = performance.now();
  wandStage  = 'queued';
  if (wandTicker) clearInterval(wandTicker);
  wandTicker = setInterval(() => updateWandTicker(), 100);
  updateWandTicker();
  btnWandCancel?.classList.remove('hidden');
}

function stopWandTicker() {
  if (wandTicker) { clearInterval(wandTicker); wandTicker = null; }
  btnWandCancel?.classList.add('hidden');
}

const STAGE_LABEL = {
  queued:   'Queued',
  fill:     'Filling',
  trace:    'Tracing boundary',
  simplify: 'Simplifying',
};

function updateWandTicker(msg) {
  const elapsed = ((performance.now() - wandStart) / 1000).toFixed(1);
  const label   = STAGE_LABEL[wandStage] ?? wandStage;
  let extra = '';
  if (msg?.filled   != null) extra += ` · ${msg.filled.toLocaleString()} px`;
  if (msg?.rawCount != null) extra += ` · ${msg.rawCount.toLocaleString()} corners`;
  setWandStatus(`${label}… ${elapsed}s${extra}`);
}

function cancelWand() {
  if (!wandPending) return;
  worker.terminate();
  worker      = null;
  workerReady = false;
  wandPending = false;
  stopWandTicker();
  setWandStatus('Cancelled.');
  initWorker();
}

wandTolerance?.addEventListener('input', () => {
  if (wandToleranceVal) wandToleranceVal.textContent = wandTolerance.value;
});
btnWandCancel?.addEventListener('click', cancelWand);

// FLOOD REGION

export function setWandStatus(msg) {
  if (wandStatus) wandStatus.textContent = msg;
}

export function triggerWand(latlng) {
  if (!state.image?.el || !workerReady) {
    setWandStatus('Still loading — try again in a moment.');
    return;
  }
  if (wandPending) return;

  const nativeX = Math.round(latlng.lng);
  const nativeY = Math.round(-latlng.lat);
  const { width, height } = state.image;

  const half = Math.floor(WINDOW / 2);
  const x0 = Math.max(0, Math.min(width  - WINDOW, nativeX - half));
  const y0 = Math.max(0, Math.min(height - WINDOW, nativeY - half));
  const ww = Math.min(WINDOW, width  - x0);
  const wh = Math.min(WINDOW, height - y0);

  const seedX = nativeX - x0;
  const seedY = nativeY - y0;
  if (seedX < 0 || seedX >= ww || seedY < 0 || seedY >= wh) return;

  const tmp = document.createElement('canvas');
  tmp.width  = ww;
  tmp.height = wh;
  const tmpCtx = tmp.getContext('2d', { willReadFrequently: true });
  tmpCtx.drawImage(state.image.el, x0, y0, ww, wh, 0, 0, ww, wh);
  const imageData = tmpCtx.getImageData(0, 0, ww, wh);

  wandOffset  = { x: x0, y: y0 };
  wandPending = true;
  startWandTicker();

  worker.postMessage({
    type: 'process',
    pixels: imageData.data.buffer,
    width: ww, height: wh,
    seedX, seedY,
    tolerance: parseFloat(wandTolerance?.value ?? 30),
    scale: 1,
  }, [imageData.data.buffer]);
}

function onWandResult({ points, simpCount, filled }) {
  wandPending = false;
  setWandStatus(`${simpCount} vertices · ${filled.toLocaleString()} px filled`);

  if (points.length < 3) {
    setWandStatus('Region too small — try a different spot or raise tolerance.');
    return;
  }

  const latlngs = points.map(p => ({
    lat: -(p.y + wandOffset.y),
    lng:   p.x + wandOffset.x,
  }));

  pushHistory();
  const region = {
    id:       generateId(),
    polygons: [latlngs],
    color:    nextColor(),
    label:    'New Region',
    body:     '',
    hidden:   false,
    layerId:  state.ui.activeLayerId,
  };
  state.annotations.regions.push(region);
  renestAround(region);
  mountRegionLayer(region);
  selectAnnotation('region', region.id);
  scheduleSave();
}
