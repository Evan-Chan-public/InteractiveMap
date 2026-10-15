// LABELS — lettering names onto the map so they don't collide, as on an old map.
//
// Regions are lettered first, in spaced capitals across the middle of the shape (its visual centre,
// the inside point farthest from the edge), sized to the region and left off when they won't fit
// inside it or would sit on a place mark; the hover slip then names it instead.
//
// Pin names follow. Each tries the right of its mark, then the left, above and below; a name with no
// free spot is left off (its mark stays, and hovering it shows the name). Lower layers hold the
// broader places, so their names are placed first: zooming out thins the detail and zooming in
// brings it back. The selected pin always keeps its name.

import { layers, state } from './state.js';
import { map } from './map.js';

const MARK   = 7;  // half a mark's size, px
const GAP    = 5;  // mark to name; matches the .label-* offsets in style.css
const MARGIN = 240; // pins this far off screen can still letter into view
const SIDES  = ['right', 'left', 'above', 'below'];
const SIDE_CLASSES = SIDES.map(s => `label-${s}`);

// the map's own controls sit over it; names placed under them would be hidden
const OVERLAYS = ['#layer-strip', '#mode-toggle > div', '.leaflet-control-zoom', '#map-banner'];

// region names: sized between these (px) to suit the region; width per letter measured at REF_PX
const NAME_MIN = 11;
const NAME_MAX = 22;
const REF_PX   = 16;

let frame = 0;

// coalesces the many triggers (zoom, pan, selection, edits) into one pass per frame
export function scheduleLabelLayout() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; layoutLabels(); });
}

// where a w×h name would sit beside a mark at screen point p
function labelBox(p, w, h, side) {
  switch (side) {
    case 'right': return { x: p.x + MARK + GAP,     y: p.y - h / 2,          w, h };
    case 'left':  return { x: p.x - MARK - GAP - w, y: p.y - h / 2,          w, h };
    case 'above': return { x: p.x - w / 2,          y: p.y - MARK - GAP - h, w, h };
    default:      return { x: p.x - w / 2,          y: p.y + MARK + GAP,     w, h };
  }
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const onScreen = (a, size) => a.x >= 0 && a.y >= 0 && a.x + a.w <= size.x && a.y + a.h <= size.y;

function overlayBoxes() {
  const origin = map.getContainer().getBoundingClientRect();
  return OVERLAYS.flatMap(sel => [...document.querySelectorAll(sel)])
    .map(el => el.getBoundingClientRect())
    .filter(r => r.width && r.height)
    .map(r => ({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }));
}

// REGION NAMES

const regionNames = new Map(); // region id → { el, key, text, at, w16, h16, shown }

export function regionNameShown(id) {
  return !!regionNames.get(id)?.shown;
}

// the inside point farthest from the edge of the largest ring (a coarse grid, refined twice):
// where a name sits clear of the border even on a crescent or an L-shaped province
function visualCenter(polygons) {
  const area = (ring) => Math.abs(ring.reduce((a, p, i) => { const q = ring[(i + 1) % ring.length]; return a + p.lng * q.lat - q.lng * p.lat; }, 0));
  const ring = polygons.reduce((best, r) => area(r) > area(best) ? r : best, polygons[0]);
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.lat > y) !== (b.lat > y) && x < (b.lng - a.lng) * (y - a.lat) / (b.lat - a.lat) + a.lng) c = !c;
    }
    return c;
  };
  const edgeDist = (x, y) => {
    let d = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      const dx = b.lng - a.lng, dy = b.lat - a.lat;
      const t  = Math.max(0, Math.min(1, ((x - a.lng) * dx + (y - a.lat) * dy) / (dx * dx + dy * dy || 1)));
      d = Math.min(d, Math.hypot(x - a.lng - t * dx, y - a.lat - t * dy));
    }
    return d;
  };
  let x0 = Math.min(...ring.map(p => p.lng)), x1 = Math.max(...ring.map(p => p.lng));
  let y0 = Math.min(...ring.map(p => p.lat)), y1 = Math.max(...ring.map(p => p.lat));
  let best = { lat: (y0 + y1) / 2, lng: (x0 + x1) / 2, d: -1 };
  for (let pass = 0; pass < 3; pass++) {
    const n = 16;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * j / n;
      if (!inside(x, y)) continue;
      const d = edgeDist(x, y);
      if (d > best.d) best = { lat: y, lng: x, d };
    }
    const w = (x1 - x0) / 8, h = (y1 - y0) / 8;
    [x0, x1, y0, y1] = [best.lng - w, best.lng + w, best.lat - h, best.lat + h];
  }
  return { lat: best.lat, lng: best.lng };
}

// a region's polygons change shape in place (brush, eraser, vertex edits): a cheap fingerprint
const shapeKey = (polygons) => polygons.map(r => `${r.length}:${r[0]?.lat},${r[0]?.lng}:${r[r.length >> 1]?.lat}`).join('|');

// a name is a plain element in its own pane (not a marker: it isn't a place you can choose),
// placed at the region's visual centre in layer coordinates
function nameElement(region) {
  let n = regionNames.get(region.id);
  const key  = shapeKey(region.polygons);
  const text = region.label || '';
  if (!n) {
    const el = L.DomUtil.create('div', 'region-name', map.getPane('regionNames'));
    el.innerHTML = '<span aria-hidden="true"></span>';
    n = { el, key: null, text: null };
    regionNames.set(region.id, n);
  }
  if (n.key !== key) {
    n.key = key;
    n.at  = visualCenter(region.polygons);
  }
  const span = n.el.firstChild;
  if (n.text !== text) {
    n.text = text;
    span.textContent = text;
    span.style.fontSize = `${REF_PX}px`;
    n.w16 = span.offsetWidth;
    n.h16 = span.offsetHeight;
  }
  return n;
}

// once the map typeface has loaded, names are measured again and re-lettered
export function lettersLoaded() {
  regionNames.forEach(n => { n.text = null; });
  scheduleLabelLayout();
}

function dropName(id) {
  regionNames.get(id)?.el.remove();
  regionNames.delete(id);
}

// which regions get lettered: those you can use (live), not the one you're inside, with a name
function letteredRegions() {
  const out = [];
  for (const region of state.annotations.regions) {
    const outline = layers.regions[region.id]?.rings?.[0]?.outline;
    const el = outline && map.hasLayer(outline) ? outline.getElement() : null;
    if (!el || !region.label || el.classList.contains('layer-dim') || el.classList.contains('drill-frame')) continue;
    out.push({ region, bounds: layers.regions[region.id].getBounds() });
  }
  return out;
}

function layoutRegionNames(taken, marks, size) {
  const wanted = letteredRegions();
  const keep   = new Set(wanted.map(w => w.region.id));
  for (const id of [...regionNames.keys()]) if (!keep.has(id)) dropName(id);

  // the largest regions are lettered first
  const placed = wanted.map(({ region, bounds }) => {
    const nw = map.latLngToContainerPoint(bounds.getNorthWest());
    const se = map.latLngToContainerPoint(bounds.getSouthEast());
    return { region, w: se.x - nw.x, h: se.y - nw.y };
  }).sort((a, b) => b.w * b.h - a.w * a.h);

  const writes = [];
  for (const { region, w, h } of placed) {
    const n  = nameElement(region);
    const fs = Math.min(NAME_MAX, (0.7 * w / n.w16) * REF_PX);
    const p  = map.latLngToContainerPoint([n.at.lat, n.at.lng]);
    const bw = n.w16 * fs / REF_PX, bh = n.h16 * fs / REF_PX;
    const box = { x: p.x - bw / 2, y: p.y - bh / 2, w: bw, h: bh };
    const fits = fs >= NAME_MIN && bh < 0.6 * h
      && box.x > -bw && box.y > -bh && box.x < size.x && box.y < size.y
      && !taken.some(t => overlaps(box, t)) && !marks.some(m => overlaps(box, m));
    n.shown = fits;
    if (fits) taken.push(box);
    writes.push([n, fits, fs, region.id === state.ui.selected?.id]);
  }
  for (const [n, fits, fs, selected] of writes) {
    const el = n.el;
    L.DomUtil.setPosition(el, map.latLngToLayerPoint([n.at.lat, n.at.lng]));
    el.classList.toggle('region-name-culled', !fits);
    el.classList.toggle('is-selected', selected);
    if (fits) el.firstChild.style.fontSize = `${fs.toFixed(1)}px`;
  }
}

function layoutLabels() {
  const size     = map.getSize();
  const depth    = new Map(state.annotations.layers.map((l, i) => [l.id, i]));
  const selected = state.ui.selected?.type === 'pin' ? state.ui.selected.id : null;
  const near     = (p) => p.x > -MARGIN && p.y > -MARGIN && p.x < size.x + MARGIN && p.y < size.y + MARGIN;

  // read everything first (one layout), then write classes
  const marks = []; // every mark on the map is an obstacle, faded ones included
  const names = []; // pins whose name is lettered in the current layer / drill-down
  state.annotations.pins.forEach((pin, index) => {
    const marker = layers.pins[pin.id];
    const el     = marker && map.hasLayer(marker) ? marker.getElement() : null;
    if (!el) return;
    const p = map.latLngToContainerPoint(pin.latlng);
    if (!near(p)) return;
    marks.push({ id: pin.id, x: p.x - MARK, y: p.y - MARK, w: 2 * MARK, h: 2 * MARK });
    if (el.classList.contains('layer-dim')) return;
    const label = el.querySelector('.place-label');
    names.push({ id: pin.id, el, p, w: label.offsetWidth, h: label.offsetHeight,
                 rank: [pin.id === selected ? 0 : 1, depth.get(pin.layerId) ?? 0, index] });
  });
  names.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);

  const taken = overlayBoxes();
  layoutRegionNames(taken, marks, size); // region names first: pin names then keep clear of them
  for (const n of names) {
    const free = (box) => onScreen(box, size)
      && !taken.some(t => overlaps(box, t))
      && !marks.some(m => m.id !== n.id && overlaps(box, m));
    let side = SIDES.find(s => free(labelBox(n.p, n.w, n.h, s)));
    if (!side && n.id === selected) side = 'right';
    if (side) taken.push(labelBox(n.p, n.w, n.h, side));

    n.el.classList.remove(...SIDE_CLASSES);
    n.el.classList.add(`label-${side ?? 'right'}`);
    n.el.classList.toggle('label-culled', !side);
  }
}
