// SHARE LINKS — annotations packed into the URL hash
//
// v2: '#z' + base64url(deflate-raw(JSON)), coordinates rounded to 0.01px.
// v1 (older links): '#' + base64(JSON). Both decode; only v2 is written when the browser can compress.

const V2_PREFIX = 'z';

// String.fromCharCode(...bytes) overflows the call stack past ~100KB, so convert in chunks
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin   = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const toUrlSafe   = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromUrlSafe = (s)   => s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');

async function pipeBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const canCompress = typeof CompressionStream !== 'undefined';

// shared links don't need sub-pixel precision; rounding roughly halves the JSON
const round = (n) => Math.round(n * 100) / 100;

function compact(annotations) {
  return {
    ...annotations,
    regions: annotations.regions.map(r => ({
      ...r,
      polygons: r.polygons.map(ring => ring.map(p => ({ lat: round(p.lat), lng: round(p.lng) }))),
    })),
    pins: annotations.pins.map(p => ({ ...p, latlng: { lat: round(p.latlng.lat), lng: round(p.latlng.lng) } })),
  };
}

export async function encodeShare(annotations, lock) {
  const json = JSON.stringify({ v: 2, lock, annotations: compact(annotations) });
  const raw  = new TextEncoder().encode(json);
  if (!canCompress) return bytesToBase64(raw); // v1 layout, readable by any version
  return V2_PREFIX + toUrlSafe(bytesToBase64(await pipeBytes(raw, new CompressionStream('deflate-raw'))));
}

// payload { lock, annotations } or null. annotations are untrusted: sanitize before use
export async function decodeShare(hash) {
  try {
    let bytes;
    if (hash.startsWith(V2_PREFIX)) {
      if (typeof DecompressionStream === 'undefined') return null;
      bytes = await pipeBytes(base64ToBytes(fromUrlSafe(hash.slice(1))), new DecompressionStream('deflate-raw'));
    } else {
      bytes = base64ToBytes(hash);
    }
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return payload?.annotations ? payload : null;
  } catch {
    return null;
  }
}
