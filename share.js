import { state } from './state.js';
import { sanitizeAnnotations } from './persistence.js';
import { parseProject } from './project.js';
import { mapParam } from './image.js';
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

// DOM

const btnShare         = document.getElementById('btn-share');
const shareDialog      = document.getElementById('share-dialog');
const shareLock        = document.getElementById('share-lock');
const shareUrl         = document.getElementById('share-url');
const shareCopy        = document.getElementById('share-copy');
const shareNote        = document.getElementById('share-note');
const fileSrc          = document.getElementById('share-file-src');
const fileUrl          = document.getElementById('share-file-url');
const fileCopy         = document.getElementById('share-file-copy');
const fileEdit         = document.getElementById('share-file-edit');
const fileNote         = document.getElementById('share-file-note');
const mapBanner        = document.getElementById('map-banner');

// links to this app carry only ?map= over from the current address (not ?gist=, ?project= or ?edit)
export function appUrl(params = {}) {
  const q = new URLSearchParams();
  if (mapParam) q.set('map', mapParam);
  for (const [k, v] of Object.entries(params)) if (v != null) q.set(k, v);
  const search = q.toString().replace(/%2F/gi, '/');
  return `${location.origin}${location.pathname}${search ? '?' + search : ''}`;
}

// SHARE DIALOG

// long links still work in the address bar, but chat apps and some sites cut them off
const LONG_LINK_CHARS = 8000;

async function refreshShareUrl() {
  shareUrl.value = 'Building link…';
  const hash = await encodeShare(state.annotations, shareLock.checked);
  shareUrl.value = `${appUrl()}#${hash}`;
  const kb = (shareUrl.value.length / 1024).toFixed(1);
  shareNote.textContent = (shareUrl.value.length > LONG_LINK_CHARS
    ? `Long link (${kb} KB): some apps may cut it off. ` : `Link size ${kb} KB. `)
    + 'The map image is not included: viewers get the baseline map if the site serves one, otherwise they upload it.';
}

// the map in a share link as a document to open, or null: { doc: { title, image, annotations }, lock }
export async function readShareHash(hash) {
  const payload = await decodeShare(hash);
  if (!payload) return null;
  return { doc: { title: '', image: null, annotations: sanitizeAnnotations(payload.annotations) }, lock: !!payload.lock };
}

// LINKS TO MAP FILES
//
// ?gist=user/id[/file]  a GitHub gist holding an exported .imap.json (latest revision; GitHub caches ~5 min)
// ?project=url          any .imap.json the browser may fetch (same site, or a host that allows CORS)
// Display-only unless &edit is present; either way nothing is saved unless the viewer keeps the map.

const GIST_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GIST_ID   = /^[0-9a-f]{20,40}$/i;
const GIST_FILE = /^[\w.-]{1,100}$/;

// "user/id" or "user/id/file" → the raw file URL, or null
export function gistRawUrl(spec) {
  const [user, id, file, ...rest] = String(spec).split('/');
  if (rest.length || !GIST_USER.test(user ?? '') || !GIST_ID.test(id ?? '') || (file && !GIST_FILE.test(file))) return null;
  return `https://gist.githubusercontent.com/${user}/${id}/raw${file ? '/' + file : ''}`;
}

// whatever the user pasted (a gist page, a raw gist link, or a plain URL) → link params, or null
export function linkParamsFor(input) {
  const text = input.trim();
  if (!/^https?:\/\//i.test(text)) return null; // a full address: stray text must not become a relative path
  let url;
  try { url = new URL(text); } catch { return null; }
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'gist.github.com' && parts.length >= 2) {
    const spec = `${parts[0]}/${parts[1]}`;
    return gistRawUrl(spec) ? { gist: spec } : null;
  }
  if (url.hostname === 'gist.githubusercontent.com' && parts.length >= 3 && parts[2] === 'raw') {
    // a raw link may pin a revision (…/raw/<sha>/<file>): link to the latest instead, keeping the file name
    const file = parts.length > 3 ? parts.at(-1) : null;
    const spec = `${parts[0]}/${parts[1]}${file && !/^[0-9a-f]{40}$/.test(file) ? '/' + file : ''}`;
    return gistRawUrl(spec) ? { gist: spec } : null;
  }
  return { project: url.origin === location.origin ? url.pathname.replace(/^\//, '') + url.search : url.href };
}

// the map file named in the address bar, as { url, edit } or null
export function linkedFile() {
  const q = new URLSearchParams(location.search);
  const edit = q.has('edit');
  if (q.has('gist')) {
    const url = gistRawUrl(q.get('gist'));
    return url ? { url, edit } : { error: 'the gist link is malformed', edit };
  }
  if (q.has('project')) return { url: q.get('project'), edit };
  return null;
}

// fetch and parse a linked map file → { doc } or { error }
export async function fetchLinkedFile(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status === 404 ? 'the file was not found (404)' : `the server answered ${res.status}`);
    return { doc: await parseProject(await res.json()) };
  } catch (err) {
    const message = err instanceof SyntaxError ? 'it is not a map file (not JSON)'
                  : err instanceof TypeError   ? 'it could not be fetched (offline, or the host blocks other sites)'
                  : err.message;
    return { error: message };
  }
}

export function showBanner(message) {
  if (!mapBanner) return;
  mapBanner.textContent = message;
  mapBanner.classList.toggle('hidden', !message);
}

function refreshFileLink() {
  const params = fileSrc.value.trim() ? linkParamsFor(fileSrc.value) : null;
  fileCopy.disabled = !params;
  if (!params) {
    fileUrl.value = '';
    fileNote.textContent = fileSrc.value.trim()
      ? 'Paste a gist address (gist.github.com/you/…) or a link to a .imap.json file.'
      : 'Export the map, add the file to a secret gist at gist.github.com, then paste the gist\'s address here.';
    return;
  }
  fileUrl.value = appUrl({ ...params, edit: fileEdit.checked ? '1' : null });
  fileNote.textContent = (params.gist ? 'Opens the latest version of the gist (updates show within ~5 minutes). ' : '')
    + (fileEdit.checked ? 'Viewers can edit, but nothing is saved unless they keep the map.' : 'Display-only for viewers.')
    + (location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? ' This app is running locally, so the link only works on this computer.' : '');
}

fileSrc?.addEventListener('input', refreshFileLink);
fileEdit?.addEventListener('change', refreshFileLink);
fileCopy?.addEventListener('click', () => {
  navigator.clipboard.writeText(fileUrl.value).then(() => {
    fileCopy.textContent = 'Copied!';
    setTimeout(() => { fileCopy.textContent = 'Copy'; }, 1500);
  });
});

btnShare.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = !shareDialog.classList.contains('hidden');
  shareDialog.classList.toggle('hidden', isOpen);
  if (!isOpen) { refreshShareUrl(); refreshFileLink(); }
});

shareLock.addEventListener('change', refreshShareUrl);

shareCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(shareUrl.value).then(() => {
    shareCopy.textContent = 'Copied!';
    setTimeout(() => { shareCopy.textContent = 'Copy'; }, 1500);
  });
});

document.addEventListener('click', (e) => {
  if (!shareDialog.classList.contains('hidden') && !shareDialog.contains(e.target) && e.target !== btnShare) {
    shareDialog.classList.add('hidden');
  }
});
