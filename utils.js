import { state } from './state.js';

export function generateId() {
  return Math.random().toString(36).slice(2, 9);
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng, yi = ring[i].lat;
    const xj = ring[j].lng, yj = ring[j].lat;
    if ((yi > pt.lat) !== (yj > pt.lat) &&
        pt.lng < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

export function pinsInRegion(region) {
  return state.annotations.pins.filter(pin =>
    region.polygons.some(ring => pointInRing(pin.latlng, ring))
  );
}

export function circlePoly(center, r, steps = 32) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const angle = (2 * Math.PI * i) / steps;
    pts.push({ lat: center.lat + r * Math.sin(angle), lng: center.lng + r * Math.cos(angle) });
  }
  return pts;
}

export function latlngDist(a, b) {
  const dlat = a.lat - b.lat;
  const dlng = a.lng - b.lng;
  return Math.sqrt(dlat * dlat + dlng * dlng);
}

// PIGMENTS — region colours, from an insular scriptorium's paint box: eight that stay distinct
// side by side. New regions cycle through them; the picker also takes any custom colour
export const PIGMENTS = [
  { name: 'Woad',      color: '#2f5a8a' }, { name: 'Minium',    color: '#c8572c' },
  { name: 'Verdigris', color: '#3a8a76' }, { name: 'Orpiment',  color: '#d9a521' },
  { name: 'Folium',    color: '#6b3d78' }, { name: 'Kermes',    color: '#9c2b33' },
  { name: 'Moss',      color: '#5e7b34' }, { name: 'Ochre',     color: '#a8722a' },
];
export const DEFAULT_REGION_COLOR = PIGMENTS[0].color;

export const pigmentName = (color) =>
  PIGMENTS.find(p => p.color === String(color).toLowerCase())?.name ?? null;

// INLINE ICONS (lucide eye / eye-off / x / chevrons / pipette)
const svg = (body) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICON_EYE     = svg('<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>');
export const ICON_EYE_OFF = svg('<path d="M10.73 5.08a10.74 10.74 0 0 1 11.2 6.57 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/>');
export const ICON_X        = svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
export const ICON_LEFT     = svg('<path d="m15 18-6-6 6-6"/>');
export const ICON_RIGHT    = svg('<path d="m9 18 6-6-6-6"/>');
export const ICON_PIPETTE  = svg('<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>');

// PIN MARKS — the inked symbol beside a pin's name, as on an old map. Drawn in currentColor;
// the ring's hollow and the gaps between the cairn's stones take the halo colour (.mark-halo in CSS)
// a place's mark, drawn as an old map draws it (14×14, inked in currentColor; the halo classes keep
// a mark legible on a busy map). Unknown marks, like an older map's cairn, show as the dot
export const PIN_MARKS = {
  dot:       { title: 'Dot', body: '<circle cx="7" cy="7" r="3.6" fill="currentColor"/>' },
  ring:      { title: 'Ring', body: '<circle class="mark-halo-fill" cx="7" cy="7" r="3.8" stroke="currentColor" stroke-width="1.7"/>' },
  star:      { title: 'Star', body: '<path class="mark-halo-stroke" stroke-width="0.6" fill="currentColor" d="M7 1.2l1.65 3.6 3.95.45-2.95 2.7.82 3.9L7 9.85l-3.47 2 .82-3.9-2.95-2.7 3.95-.45z"/>' },
  town:      { title: 'Town', body: '<path class="mark-halo-stroke" stroke-width="0.6" fill="currentColor" d="M1.3 12.5V7.6L4 5.1l2.7 2.5v4.9zM7.3 12.5V5.4l1.1-.9V1.6h1.1v2l2.9 2.3v6.6z"/><path class="mark-halo-fill" d="M3.4 12.5v-2h1.2v2zM9.3 12.5v-2.2h1.3v2.2z"/>' },
  castle:    { title: 'Castle', body: '<path class="mark-halo-stroke" stroke-width="0.6" fill="currentColor" d="M2.2 12.6V3.4h1.9v1.5h1.5V3.4h2.8v1.5h1.5V3.4h1.9v9.2z"/><path class="mark-halo-fill" d="M5.6 12.6V9.7a1.4 1.4 0 0 1 2.8 0v2.9z"/>' },
  monastery: { title: 'Monastery', body: '<g class="mark-halo-stroke" stroke-width="0.6" fill="currentColor"><path d="M6.05 1.2h1.9v3h3.1v1.9H7.95v4.5h-1.9V6.1H2.95V4.2h3.1z"/><path d="M4.6 12.8l.7-2.2h3.4l.7 2.2z"/></g><circle cx="7" cy="5.15" r="2.35" fill="none" stroke="currentColor" stroke-width="1.1"/>' },
  mountain:  { title: 'Mountain', body: '<path class="mark-halo-stroke" stroke-width="0.6" fill="currentColor" d="M.8 12.3L5.4 3.3l2.3 4.2 1.4-2.2 4.1 7z"/><path class="mark-halo-fill" d="M5.4 3.3l1 4.6-1.6 1.6 2.1 2.8H5.6L3.9 9.5l1.4-1.8z" opacity="0.55"/>' },
  forest:    { title: 'Forest', body: '<path class="mark-halo-stroke" stroke-width="0.6" fill="currentColor" d="M4.6 1.6l3 4.3H6.2l2.3 3.4H5.3v2.9H3.9V9.3H.7L3 5.9H1.6zM10.2 4.2l2.4 3.6h-1.1l1.9 2.8h-2.5v1.9H9.7v-1.9H7.4L9.3 7.8H8.2z"/>' },
  lake:      { title: 'Lake', body: '<path class="mark-halo-stroke" stroke-width="3.2" stroke-linecap="round" fill="none" d="M1.6 4.6q1.35-1.5 2.7 0t2.7 0 2.7 0 2.7 0M1.6 8.1q1.35-1.5 2.7 0t2.7 0 2.7 0 2.7 0M3 11.6q1.35-1.5 2.7 0t2.7 0 2.7 0"/><path stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none" d="M1.6 4.6q1.35-1.5 2.7 0t2.7 0 2.7 0 2.7 0M1.6 8.1q1.35-1.5 2.7 0t2.7 0 2.7 0 2.7 0M3 11.6q1.35-1.5 2.7 0t2.7 0 2.7 0"/>' },
  port:      { title: 'Port', body: '<path class="mark-halo-stroke" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none" d="M7 4.2v8.4M4.4 5.6h5.2M2.4 8.6q.6 3.9 4.6 4 4-.1 4.6-4"/><g stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"><circle cx="7" cy="2.6" r="1.4"/><path d="M7 4.2v8.4M4.4 5.6h5.2M2.4 8.6q.6 3.9 4.6 4 4-.1 4.6-4"/></g><path fill="currentColor" d="M1.2 9.6l1.2-2 1.2 2zM10.4 9.6l1.2-2 1.2 2z"/>' },
  ford:      { title: 'Ford or bridge', body: '<path class="mark-halo-stroke" stroke-width="0.6" fill="currentColor" d="M.6 8.6Q7 3.4 13.4 8.6v3.9h-1.5a2 2.2 0 0 0-4 0H6.1a2 2.2 0 0 0-4 0H.6z"/>' },
};
export const DEFAULT_MARK = 'dot';

export const markSvg = (mark, size = 14) =>
  `<svg viewBox="0 0 14 14" width="${size}" height="${size}" aria-hidden="true">${(PIN_MARKS[mark] ?? PIN_MARKS[DEFAULT_MARK]).body}</svg>`;

// ring [{lat,lng}] → polygon-clipping Polygon [[[x,y],...]]
export const ringToGeom = (ring) => [ring.map(p => [p.lng, p.lat])];

// polygon-clipping MultiPolygon → rings [{lat,lng}], one per piece. Holes are dropped.
export const geomToRings = (multi) => multi.map(([outer]) => outer.map(([lng, lat]) => ({ lat, lng })));

// gap distance bridged before merging (in map units / px at scale 1)
export const MERGE_BUFFER_PX = 4;

export function inflatePolygon(points, distance) {
  const n = points.length;
  if (n < 3) return points.slice();

  let signed = 0;
  for (let i = 0; i < n; ++i) {
    const a = points[i], b = points[(i + 1) % n];
    signed += a.lng * b.lat - b.lng * a.lat;
  }
  const orient = signed > 0 ? 1 : -1;

  const result = new Array(n);
  for (let i = 0; i < n; ++i) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];

    const e1x = curr.lng - prev.lng, e1y = curr.lat - prev.lat;
    const e2x = next.lng - curr.lng, e2y = next.lat - curr.lat;
    const e1Len = Math.hypot(e1x, e1y);
    const e2Len = Math.hypot(e2x, e2y);
    if (e1Len < 1e-9 || e2Len < 1e-9) { result[i] = { ...curr }; continue; }

    const n1x = orient * e1y / e1Len, n1y = -orient * e1x / e1Len;
    const n2x = orient * e2y / e2Len, n2y = -orient * e2x / e2Len;

    let bx = n1x + n2x, by = n1y + n2y;
    const bLen = Math.hypot(bx, by);

    if (bLen < 1e-9) {
      result[i] = { lng: curr.lng + n1x * distance, lat: curr.lat + n1y * distance };
      continue;
    }
    bx /= bLen; by /= bLen;

    const cosHalf = n1x * bx + n1y * by;
    const factor  = cosHalf > 0.05 ? distance / cosHalf : distance * 20;
    result[i] = { lng: curr.lng + bx * factor, lat: curr.lat + by * factor };
  }
  return result;
}
