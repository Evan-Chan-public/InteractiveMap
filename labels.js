// LABELS — lettering pin names so they don't collide, as on an old map. Each name tries the right of
// its mark, then the left, above and below; a name with no free spot is left off (its mark stays,
// and hovering it shows the name). Lower layers hold the broader places, so their names are placed
// first: zooming out thins the detail and zooming in brings it back. The selected pin always keeps
// its name.

import { layers, state } from './state.js';
import { map } from './map.js';

const MARK   = 7;  // half a mark's size, px
const GAP    = 5;  // mark to name; matches the .label-* offsets in style.css
const MARGIN = 240; // pins this far off screen can still letter into view
const SIDES  = ['right', 'left', 'above', 'below'];
const SIDE_CLASSES = SIDES.map(s => `label-${s}`);

// the map's own controls sit over it; names placed under them would be hidden
const OVERLAYS = ['#layer-strip', '#mode-toggle > div', '.leaflet-control-zoom', '#map-banner'];

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
