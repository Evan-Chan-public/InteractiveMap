// LABELS — lettering names onto the map so they don't collide, as on an old map.
//
// Regions are lettered first, in spaced capitals set along the shape and bending with it, sized to
// the room inside and left off when they won't fit inside it or would sit on a place mark; the
// hover slip then names it instead.
//
// Pin names follow. Each tries the right of its mark, then the left, above and below; a name with no
// free spot is left off (its mark stays, and hovering it shows the name). Lower layers hold the
// broader places, so their names are placed first: zooming out thins the detail and zooming in
// brings it back. The selected pin always keeps its name.

import { layers, state } from './state.js';
import { map } from './map.js';
import { isPicked } from './selection.js';

const MARK   = 7;  // half a mark's size, px
const GAP    = 5;  // mark to name; matches the .label-* offsets in style.css
const MARGIN = 240; // pins this far off screen can still letter into view
const SIDES  = ['right', 'left', 'above', 'below'];
const SIDE_CLASSES = SIDES.map(s => `label-${s}`);

// the map's own controls sit over it; names placed under them would be hidden
const OVERLAYS = ['#layer-strip', '#mode-toggle > div', '.leaflet-control-zoom', '#map-banner'];

// region names: sized between these (px) to suit the region; letters measured at REF_PX
const NAME_MIN = 10;
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

// REGION NAMES — lettered along the region, as an old map letters a province: spaced capitals
// following the shape's long axis and bending with it where it bends, sized to the room inside, and
// spread wider when there's room to spare. A name that won't fit along the shape tries straight
// across its middle; failing that it's left off, and the hover slip names the region instead

const regionNames = new Map(); // region id → { el, line, key, text, spine, glyphs, shown }

export function regionNameShown(id) {
  return !!regionNames.get(id)?.shown;
}

const STATIONS = 40;   // cross-sections taken along a region's long axis
const TRACK    = 0.18; // letter spacing (em): the least, and what a name is measured with
const SPREAD   = 0.7;  // a name may be spaced out to fill this much of the room along the region
const MAX_TRACK = 0.8;
const CAP      = 0.72; // a capital's height, per px of font size
const BEND     = 0.3;  // the most a name bows from straight, per unit of its length

function largestRing(polygons) {
  const area = (ring) => Math.abs(ring.reduce((a, p, i) => { const q = ring[(i + 1) % ring.length]; return a + p.lng * q.lat - q.lng * p.lat; }, 0));
  return polygons.reduce((best, r) => area(r) > area(best) ? r : best, polygons[0]);
}

// the region's long axis (the principal axis of its area) and, at stations along it, the strip of
// the shape that crosses it there: { o, u, v, stations: [{ t, mid, w }] } in map units, x = lng, y = lat.
// where the axis crosses the shape more than once, the strip keeps to the piece it's already in
function axisOf(ring, angle = null) {
  const x0 = ring[0].lng, y0 = ring[0].lat;
  const pts = ring.map(p => [p.lng - x0, p.lat - y0]);
  let A = 0, cx = 0, cy = 0, ixx = 0, iyy = 0, ixy = 0;
  pts.forEach(([x1, y1], i) => {
    const [x2, y2] = pts[(i + 1) % pts.length];
    const c = x1 * y2 - x2 * y1;
    A += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c;
    ixx += (x1 * x1 + x1 * x2 + x2 * x2) * c;
    iyy += (y1 * y1 + y1 * y2 + y2 * y2) * c;
    ixy += (x1 * y2 + 2 * x1 * y1 + 2 * x2 * y2 + x2 * y1) * c;
  });
  if (!A) return null;
  A /= 2; cx /= 6 * A; cy /= 6 * A;
  const sxx = ixx / (12 * A) - cx * cx, syy = iyy / (12 * A) - cy * cy, sxy = ixy / (24 * A) - cx * cy;
  const th = angle ?? 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const u = [Math.cos(th), Math.sin(th)], v = [-u[1], u[0]];
  const tc = pts.map(([x, y]) => [(x - cx) * u[0] + (y - cy) * u[1], (x - cx) * v[0] + (y - cy) * v[1]]);
  const t0 = Math.min(...tc.map(p => p[0])), t1 = Math.max(...tc.map(p => p[0]));

  // every piece of the shape each cross-section passes through
  const cuts = [];
  for (let k = 0; k < STATIONS; k++) {
    const t = t0 + (t1 - t0) * (k + 0.5) / STATIONS;
    const ss = [];
    tc.forEach(([ta, sa], i) => {
      const [tb, sb] = tc[(i + 1) % tc.length];
      if ((ta > t) !== (tb > t)) ss.push(sa + (t - ta) / (tb - ta) * (sb - sa));
    });
    ss.sort((a, b) => a - b);
    const pieces = [];
    for (let i = 0; i + 1 < ss.length; i += 2) pieces.push([ss[i], ss[i + 1]]);
    cuts.push({ t, pieces });
  }
  // start from the widest piece anywhere, and walk out both ways through the pieces that touch it
  let seed = -1, seedPiece = null;
  cuts.forEach((c, k) => c.pieces.forEach(p => { if (!seedPiece || p[1] - p[0] > seedPiece[1] - seedPiece[0]) { seed = k; seedPiece = p; } }));
  if (!seedPiece) return null;
  const strip = new Array(STATIONS).fill(null);
  strip[seed] = seedPiece;
  for (const dir of [-1, 1]) {
    let prev = seedPiece;
    for (let k = seed + dir; k >= 0 && k < STATIONS; k += dir) {
      const touching = cuts[k].pieces.map(p => [p, Math.min(p[1], prev[1]) - Math.max(p[0], prev[0])]).filter(([, o]) => o > 0);
      if (!touching.length) break;
      prev = touching.reduce((a, b) => b[1] > a[1] ? b : a)[0];
      strip[k] = prev;
    }
  }
  const stations = cuts.map((c, k) => strip[k] && { t: c.t, mid: (strip[k][0] + strip[k][1]) / 2, w: strip[k][1] - strip[k][0] });
  return { o: [x0 + cx, y0 + cy], u, v, step: (t1 - t0) / STATIONS, stations };
}

// a region's polygons change shape in place (brush, eraser, vertex edits): a cheap fingerprint
const shapeKey = (polygons) => polygons.map(r => `${r.length}:${r[0]?.lat},${r[0]?.lng}:${r[r.length >> 1]?.lat}`).join('|');

// the widths of a name's capitals at REF_PX, for setting them one by one
let measure = null;
function glyphWidths(text, span) {
  measure ??= document.createElement('canvas').getContext('2d');
  const cs = getComputedStyle(span);
  measure.font = `${cs.fontWeight} ${REF_PX}px ${cs.fontFamily}`;
  return [...text.toUpperCase()].map(ch => ({ ch, w: measure.measureText(ch).width }));
}

// a name is a plain element in its own pane (not a marker: it isn't a place you can choose): a line
// of capitals, each set in place along the region
function nameElement(region) {
  let n = regionNames.get(region.id);
  const key  = shapeKey(region.polygons);
  const text = region.label || '';
  if (!n) {
    const el = L.DomUtil.create('div', 'region-name', map.getPane('regionNames'));
    el.innerHTML = '<span aria-hidden="true"></span>';
    n = { el, line: el.firstChild, key: null, text: null };
    regionNames.set(region.id, n);
  }
  if (n.key !== key) {
    n.key = key;
    const ring = largestRing(region.polygons);
    const at   = visualCenter(region.polygons);
    n.spine    = axisOf(ring);
    n.across   = axisOf(ring, 0); // straight across, the fallback
    n.at       = at;
  }
  if (n.text !== text) {
    n.text = text;
    n.glyphs = glyphWidths(text, n.line);
    n.line.replaceChildren(...n.glyphs.map(g => {
      const i = document.createElement('i');
      i.textContent = g.ch === ' ' ? ' ' : g.ch;
      return i;
    }));
  }
  return n;
}

// the inside point farthest from the edge of the largest ring (a coarse grid, refined twice):
// where a straight name is centred when it can't follow the shape
function visualCenter(polygons) {
  const ring = largestRing(polygons);
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

// least squares s = a + b·t + c·t² through the strip's middles (bent no more than BEND allows)
function fitCurve(run, straightAt = null) {
  if (straightAt !== null) return { a: straightAt, b: 0, c: 0 };
  const n = run.length;
  const tm = run.reduce((a, r) => a + r.t, 0) / n;
  let S = [0, 0, 0, 0, 0], T = [0, 0, 0];
  for (const { t, mid } of run) {
    const x = t - tm;
    S = [S[0] + 1, S[1] + x, S[2] + x * x, S[3] + x ** 3, S[4] + x ** 4];
    T = [T[0] + mid, T[1] + x * mid, T[2] + x * x * mid];
  }
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]];
  const D = det3(M);
  let [a, b, c] = [T[0] / n, 0, 0];
  if (Math.abs(D) > 1e-12) {
    const col = (i) => M.map((row, r) => row.map((x, j) => j === i ? T[r] : x));
    [a, b, c] = [det3(col(0)) / D, det3(col(1)) / D, det3(col(2)) / D];
  }
  const half = (run[n - 1].t - run[0].t) / 2;
  const maxC = half ? (BEND * 2 * half) / (half * half) : 0;
  c = Math.max(-maxC, Math.min(maxC, c));
  // re-centre on t = 0 of the axis
  return { a: a - b * tm + c * tm * tm, b: b - 2 * c * tm, c };
}

// one try at setting a name of `fs` px along `axis` over the stations of `run`, centred `along` the
// way: each letter's layer position and angle, or null if a letter would leave the shape
function setAlong(n, axis, run, fs, view, curve, along) {
  const { scale, po } = view;
  const sumW  = n.glyphs.reduce((a, g) => a + g.w, 0) * fs / REF_PX;
  const gaps  = Math.max(1, n.glyphs.length - 1);
  const room  = (run[run.length - 1].t - run[0].t + axis.step) * scale;
  const track = Math.min(MAX_TRACK, Math.max(TRACK, (room * SPREAD - sumW) / (gaps * fs)));
  const total = sumW + track * fs * gaps;
  if (total > room * 0.92) return null;

  const s     = (t) => curve.a + curve.b * t + curve.c * t * t;
  const point = (t) => { const sv = s(t); return [axis.o[0] + t * axis.u[0] + sv * axis.v[0], axis.o[1] + t * axis.u[1] + sv * axis.v[1]]; };
  const toPx  = ([x, y]) => ({ x: x * scale - po.x, y: -y * scale - po.y }); // CRS.Simple, unrounded
  // walk the curve in small steps, measuring its length on screen
  const tA = run[0].t - axis.step / 2, tB = run[run.length - 1].t + axis.step / 2;
  const steps = 64, path = [];
  let len = 0, prev = null;
  for (let k = 0; k <= steps; k++) {
    const t = tA + (tB - tA) * k / steps;
    const p = toPx(point(t));
    if (prev) len += Math.hypot(p.x - prev.x, p.y - prev.y);
    path.push({ t, p, len });
    prev = p;
  }
  const at = (d) => {
    let k = path.findIndex(q => q.len >= d);
    if (k <= 0) k = 1;
    const a = path[k - 1], b = path[k], f = (d - a.len) / ((b.len - a.len) || 1);
    return { t: a.t + (b.t - a.t) * f, x: a.p.x + (b.p.x - a.p.x) * f, y: a.p.y + (b.p.y - a.p.y) * f, ang: Math.atan2(b.p.y - a.p.y, b.p.x - a.p.x) };
  };
  // read left to right (or upward, when it stands on end)
  const head = path[0].p, tail = path[path.length - 1].p;
  const flip = tail.x - head.x < -0.5 || (Math.abs(tail.x - head.x) <= 0.5 && tail.y > head.y);
  const start = len * along - total / 2;
  if (start < 0 || start + total > len) return null;

  const capHalf = CAP * fs / 2 / scale;
  const out = [];
  let d = start;
  const order = flip ? [...n.glyphs].reverse() : n.glyphs;
  const placed = [];
  for (const g of order) {
    const w = g.w * fs / REF_PX;
    const q = at(flip ? len - (d + w / 2) : d + w / 2);
    // the letter, a capital high, must lie inside the strip where it sits
    const k = Math.min(run.length - 1, Math.max(0, Math.round((q.t - run[0].t) / axis.step)));
    const st = run[k];
    if (!st || Math.abs(s(q.t) - st.mid) + capHalf > st.w / 2) return null;
    placed.push({ x: q.x, y: q.y, ang: flip ? q.ang + Math.PI : q.ang, w });
    d += w + track * fs;
  }
  out.push(...(flip ? placed.reverse() : placed));
  return { glyphs: out, fs };
}

// the longest unbroken stretch of the strip at least `minW` across
function longestRun(stations, minW) {
  let best = null, cur = [];
  for (const st of [...stations, null]) {
    if (st && st.w >= minW) { cur.push(st); continue; }
    if (cur.length && (!best || cur.length > best.length)) best = cur;
    cur = [];
  }
  return best;
}

// where a name may sit, best first: the middle of the strip, then slid along it and to either side
const ALONG  = [0.5, 0.35, 0.65, 0.2, 0.8];
const ASIDE  = [0, -0.22, 0.22];

// the largest size that sets the name inside the shape, along it or else straight across, somewhere
// `clear` accepts (not over another name, a place mark or the map's controls)
function fitName(n, view, clear) {
  if (!n.glyphs.length) return null;
  for (let fs = NAME_MAX; fs >= NAME_MIN; fs--) {
    const minW = 1.35 * CAP * fs / view.scale;
    for (const [axis, straight] of [[n.spine, false], [n.across, true]]) {
      if (!axis) continue;
      const run = longestRun(axis.stations, minW);
      if (!run || run.length < 2) continue;
      const mid  = run[run.length >> 1];
      const base = fitCurve(run, straight ? mid.mid : null);
      for (const aside of ASIDE) {
        const curve = { ...base, a: base.a + aside * mid.w };
        for (const along of ALONG) {
          const set = setAlong(n, axis, run, fs, view, curve, along);
          if (set && clear(set)) return set;
        }
      }
    }
  }
  return null;
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

// a letter's footprint on screen (container px), turned with it
function glyphBox(g, fs, origin) {
  const h = CAP * fs, c = Math.abs(Math.cos(g.ang)), s = Math.abs(Math.sin(g.ang));
  const w = g.w * c + h * s, hh = g.w * s + h * c;
  return { x: g.x - origin.x - w / 2, y: g.y - origin.y - hh / 2, w, h: hh };
}

function layoutRegionNames(taken, marks, size) {
  const wanted = letteredRegions();
  const keep   = new Set(wanted.map(w => w.region.id));
  for (const id of [...regionNames.keys()]) if (!keep.has(id)) dropName(id);
  if (!wanted.length) return; // (and the map may have no view yet)

  const scale  = map.getZoomScale(map.getZoom(), 0); // screen px per map unit
  const view   = { scale, po: map.getPixelOrigin() };
  const origin = map.containerPointToLayerPoint([0, 0]);
  const seen   = map.getBounds().pad(0.2);

  // the largest regions are lettered first
  const placed = wanted.map(({ region, bounds }) => {
    const nw = map.latLngToContainerPoint(bounds.getNorthWest());
    const se = map.latLngToContainerPoint(bounds.getSouthEast());
    return { region, bounds, area: (se.x - nw.x) * (se.y - nw.y) };
  }).sort((a, b) => b.area - a.area);

  for (const { region, bounds } of placed) {
    const n = nameElement(region);
    let boxes = [];
    const clear = (set) => {
      boxes = set.glyphs.map(g => glyphBox(g, set.fs, origin));
      return boxes.some(b => onScreen(b, size))
        && !boxes.some(b => taken.some(t => overlaps(b, t)) || marks.some(m => overlaps(b, m)));
    };
    const set  = seen.intersects(bounds) ? fitName(n, view, clear) : null;
    const fits = !!set;
    n.shown = fits;
    n.el.classList.toggle('region-name-culled', !fits);
    n.el.classList.toggle('is-selected', isPicked(region.id));
    if (!fits) continue;
    taken.push(...boxes);
    n.line.style.fontSize = `${set.fs.toFixed(1)}px`;
    [...n.line.children].forEach((el, i) => {
      const g = set.glyphs[i];
      el.style.transform = `translate(${g.x.toFixed(1)}px, ${g.y.toFixed(1)}px) rotate(${g.ang.toFixed(3)}rad) translate(-50%, -50%)`;
    });
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
    const dim = el.classList.contains('layer-dim');
    if (dim && state.mode === 'display') return; // out of sight beneath: no obstacle
    marks.push({ id: pin.id, x: p.x - MARK, y: p.y - MARK, w: 2 * MARK, h: 2 * MARK });
    if (dim) return;
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
