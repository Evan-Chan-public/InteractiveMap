// WASM worker — flood fill → contour trace → RDP simplify → polygon points

importScripts('./processor.js');

let Module = null;

createProcessor().then(mod => {
  Module = mod;
  postMessage({ type: 'ready' });
});

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'process') handleProcess(msg);
};

function handleProcess({ pixels, width, height, seedX, seedY, tolerance, scale }) {
  if (!Module) { postMessage({ type: 'error', reason: 'not ready' }); return; }

  const pixelBytes = width * height * 4;
  const maskBytes  = width * height;

  // ALLOC
  const pixPtr  = Module._wasmAlloc(pixelBytes);
  const maskPtr = Module._wasmAlloc(maskBytes);
  Module.HEAPU8.set(new Uint8Array(pixels), pixPtr);
  Module.HEAPU8.fill(0, maskPtr, maskPtr + maskBytes); // wasmAlloc doesn't zero memory

  // FILL
  const filled = Module._floodFill(pixPtr, width, height, seedX, seedY, tolerance, maskPtr);
  postMessage({ type: 'progress', stage: 'fill' });
  if (filled === 0) { cleanup([pixPtr, maskPtr]); postMessage({ type: 'empty' }); return; }

  // TRACE
  const maxPairs = width * height;
  const tracePtr = Module._wasmAlloc(maxPairs * 2 * 4); // float32 pairs
  const rawCount = Module._traceBoundary(maskPtr, width, height, tracePtr, maxPairs);
  postMessage({ type: 'progress', stage: 'trace', filled });

  // SIMPLIFY
  const simpPtr = Module._wasmAlloc(rawCount * 2 * 4);
  postMessage({ type: 'progress', stage: 'simplify', filled, rawCount });
  const epsilon = 0.5; // must stay below 1/√2 ≈ 0.707 to preserve right-angle corners
  const simpCount = Module._simplifyRDP(tracePtr, rawCount, simpPtr, epsilon);

  // READ BACK
  const rawF32 = new Float32Array(Module.HEAPU8.buffer, simpPtr, simpCount * 2);
  const points = [];
  for (let i = 0; i < simpCount; i++) {
    points.push({ x: rawF32[i * 2] * scale, y: rawF32[i * 2 + 1] * scale });
  }

  // FREE
  cleanup([pixPtr, maskPtr, tracePtr, simpPtr]);
  postMessage({ type: 'result', points, rawCount, simpCount, filled });
}

function cleanup(ptrs) {
  for (const p of ptrs) Module._wasmFree(p);
}
