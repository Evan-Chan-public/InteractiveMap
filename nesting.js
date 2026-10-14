// NESTING — stored parent links (item.parentId / item.parentManual), auto-assigned from geometry
//
// auto parent = region on the nearest layer closer to root (lower index) that covers most of the item;
// for pins, the smallest region containing the point, starting with the pin's own layer.
// Region parents are always on a different layer; pins can't contain anything, so a same-layer
// region is safe (and is the natural home for a city pin drawn on a provinces layer).
// Links are only recomputed on create / reshape / layer move / parent delete / explicit re-nest,
// never on layer reorder. Manual links (parentManual) are left alone except when their parent is deleted.

import { state } from './state.js';
import { pointInRing, ringToGeom } from './utils.js';

const COVER_MIN = 0.5; // share of a child's area a parent must cover

// GEOMETRY

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].lng + ring[i].lng) * (ring[j].lat - ring[i].lat);
  }
  return Math.abs(a / 2);
}

export function regionArea(region) {
  return region.polygons.reduce((sum, ring) => sum + ringArea(ring), 0);
}

// polygon-clipping MultiPolygon [[outer, ...holes], ...] of [lng, lat] -> area
function geomArea(multi) {
  const area = (ring) => ringArea(ring.map(([lng, lat]) => ({ lat, lng })));
  return multi.reduce((sum, [outer, ...holes]) =>
    sum + area(outer) - holes.reduce((h, r) => h + area(r), 0), 0);
}

function bboxOf(region) {
  const b = { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity };
  for (const ring of region.polygons) {
    for (const p of ring) {
      if (p.lat < b.minLat) b.minLat = p.lat;
      if (p.lat > b.maxLat) b.maxLat = p.lat;
      if (p.lng < b.minLng) b.minLng = p.lng;
      if (p.lng > b.maxLng) b.maxLng = p.lng;
    }
  }
  return b;
}

function bboxesOverlap(a, b) {
  return a.minLat <= b.maxLat && b.minLat <= a.maxLat && a.minLng <= b.maxLng && b.minLng <= a.maxLng;
}

function bboxHasPoint(b, p) {
  return p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng;
}

// share of child's area inside parent (0..1)
function coverage(child, parent) {
  const childArea = regionArea(child);
  if (!childArea) return 0;
  if (typeof polygonClipping === 'undefined') {
    // fallback: is the child's first vertex inside the parent
    const p = child.polygons[0]?.[0];
    return p && parent.polygons.some(ring => pointInRing(p, ring)) ? 1 : 0;
  }
  try {
    const inter = polygonClipping.intersection(
      child.polygons.map(ringToGeom),
      parent.polygons.map(ringToGeom),
    );
    return geomArea(inter) / childArea;
  } catch (err) {
    console.warn('coverage intersection failed:', err);
    return 0;
  }
}

// LOOKUPS

export function findAnnotation(type, id) {
  const list = type === 'region' ? state.annotations.regions : state.annotations.pins;
  return list.find(a => a.id === id);
}

export function findItem(id) {
  return state.annotations.regions.find(r => r.id === id)
      || state.annotations.pins.find(p => p.id === id);
}

export function itemType(item) {
  return item.latlng ? 'pin' : 'region';
}

export function childrenOf(id) {
  return {
    regions: state.annotations.regions.filter(r => r.parentId === id),
    pins:    state.annotations.pins.filter(p => p.parentId === id),
  };
}

// [root, ..., parent] for an item
export function ancestorsOf(item) {
  const chain = [];
  const seen  = new Set([item.id]);
  let cur = item.parentId ? findItem(item.parentId) : null;
  while (cur && !seen.has(cur.id)) {
    chain.unshift(cur);
    seen.add(cur.id);
    cur = cur.parentId ? findItem(cur.parentId) : null;
  }
  return chain;
}

// true if making parentId the parent of childId would close a loop
export function wouldCycle(childId, parentId) {
  const seen = new Set();
  let cur = parentId;
  while (cur && !seen.has(cur)) {
    if (cur === childId) return true;
    seen.add(cur);
    cur = findItem(cur)?.parentId;
  }
  return false;
}

// AUTO ASSIGNMENT

export function autoParent(item) {
  const layers  = state.annotations.layers;
  const idx     = layers.findIndex(l => l.id === item.layerId);
  const isPin   = itemType(item) === 'pin';
  const itemBox = isPin ? null : bboxOf(item);

  for (let li = isPin ? idx : idx - 1; li >= 0; li--) {
    let best = null, bestArea = Infinity;
    for (const r of state.annotations.regions) {
      if (r.layerId !== layers[li].id || !r.polygons.length) continue;
      const box = bboxOf(r);
      const fits = isPin
        ? bboxHasPoint(box, item.latlng) && r.polygons.some(ring => pointInRing(item.latlng, ring))
        : bboxesOverlap(box, itemBox) && coverage(item, r) > COVER_MIN;
      if (!fits || wouldCycle(item.id, r.id)) continue;
      const area = regionArea(r);
      if (area < bestArea) { best = r; bestArea = area; }
    }
    if (best) return best.id;
  }
  return null;
}

// recompute auto links for the given items (manual links untouched).
// clear the batch first so a stale link inside it can't block another item's loop check
export function renest(items) {
  const auto = items.filter(it => !it.parentManual);
  auto.forEach(it => { it.parentId = null; });
  auto.forEach(it => { it.parentId = autoParent(it); });
}

// after a region/pin is created, reshaped or moved: the item itself, its children,
// and anything on a layer farther from root that it now overlaps (pins: its own layer too)
export function renestAround(item) {
  renest([item]);
  if (itemType(item) !== 'region') return;
  const layers = state.annotations.layers;
  const idx    = layers.findIndex(l => l.id === item.layerId);
  const box    = item.polygons.length ? bboxOf(item) : null;
  const depth  = (other) => layers.findIndex(l => l.id === other.layerId);
  const affected = [
    ...state.annotations.regions.filter(r => r.id !== item.id && (r.parentId === item.id ||
      (box && depth(r) > idx && r.polygons.length && bboxesOverlap(bboxOf(r), box)))),
    ...state.annotations.pins.filter(p => p.parentId === item.id ||
      (box && depth(p) >= idx && bboxHasPoint(box, p.latlng))),
  ];
  renest(affected);
}

// after items are deleted: their children lose the link (manual or not) and re-auto
export function orphanChildrenOf(ids) {
  const gone = new Set(ids);
  const orphans = [...state.annotations.regions, ...state.annotations.pins]
    .filter(it => gone.has(it.parentId));
  orphans.forEach(it => { it.parentManual = false; it.parentId = null; });
  renest(orphans);
}

export function renestAll(layerId = null) {
  renest([...state.annotations.regions, ...state.annotations.pins]
    .filter(it => !layerId || it.layerId === layerId));
}

// older saves have no parent links: assign them once on load
export function ensureNesting() {
  const all = [...state.annotations.regions, ...state.annotations.pins];
  if (all.every(it => 'parentId' in it)) return;
  all.forEach(it => { if (!('parentId' in it)) { it.parentId = null; it.parentManual = false; } });
  renest(all);
}

// VIEW — the tree as the current mode shows it (display mode skips hidden items)

export function visibleInMode(it) {
  return state.mode !== 'display' || !it.hidden;
}

// children as the current mode shows them: a hidden child is skipped and its children take its place
export function childrenInView(id, seen = new Set([id])) {
  const { regions, pins } = childrenOf(id);
  const out = { regions: [], pins: pins.filter(visibleInMode) };
  for (const r of regions) {
    if (visibleInMode(r)) { out.regions.push(r); continue; }
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const sub = childrenInView(r.id, seen);
    out.regions.push(...sub.regions);
    out.pins.push(...sub.pins);
  }
  return out;
}

export const countInView = ({ regions, pins }) => regions.length + pins.length;

// nearest ancestor the current mode shows
export function parentInView(item) {
  return item ? ancestorsOf(item).filter(visibleInMode).at(-1) ?? null : null;
}
