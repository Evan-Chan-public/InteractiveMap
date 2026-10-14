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

// INLINE ICONS (lucide eye / eye-off)
const svg = (body) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICON_EYE     = svg('<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>');
export const ICON_EYE_OFF = svg('<path d="M10.73 5.08a10.74 10.74 0 0 1 11.2 6.57 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/>');

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
