/**
 * Runs OCEAN worklet engines in Node: mocks the AudioWorkletGlobalScope
 * so `node --test` can render audio offline and deterministically.
 */
const registered = [];

globalThis.sampleRate = 48000;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage() {} };
  }
};
globalThis.registerProcessor = (name, cls) => registered.push(cls);

export async function loadEngine(fileUrl) {
  const before = registered.length;
  // bust Node's ES-module cache: re-importing the same URL twice (e.g. the
  // same legacy/engine file loaded by two different tests) would otherwise
  // resolve to the already-evaluated module and never re-run
  // registerProcessor, leaving `registered` unchanged.
  const bustedUrl = new URL(fileUrl);
  bustedUrl.searchParams.set('t', `${Date.now()}-${Math.random()}`);
  await import(bustedUrl.href);
  if (registered.length === before) throw new Error(`no processor in ${fileUrl}`);
  return registered[registered.length - 1];
}

export function send(proc, type, data) {
  proc.port.onmessage({ data: { type, data } });
}

/** Render `seconds` of stereo audio in 128-sample quanta. `onQuantum(q)`,
 *  if given, runs BEFORE quantum q is processed; a returned object is sent
 *  as a params patch (merged via the engine's Object.assign ingestion),
 *  letting a test move the listener mid-render (e.g. the Doppler test).
 *  Returning null/undefined is a no-op — backward compatible with every
 *  existing 3-arg call site. */
export function render(proc, seconds, params, onQuantum) {
  if (params) send(proc, 'params', params);
  const quanta = Math.ceil((seconds * 48000) / 128);
  const L = new Float32Array(quanta * 128);
  const R = new Float32Array(quanta * 128);
  for (let q = 0; q < quanta; q++) {
    if (onQuantum) {
      const patch = onQuantum(q);
      if (patch) send(proc, 'params', patch);
    }
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    proc.process([], [[l, r]]);
    L.set(l, q * 128);
    R.set(r, q * 128);
    globalThis.currentTime += 128 / 48000;
  }
  return { L, R };
}

export const BASE_PARAMS = {
  tau: 0.02, density: 0.55, scale: 0.4, colorRandom: 0.5, sizeRandom: 1.0,
  smear: 0.5, asymmetry: 0.0, tint: [0.75, 0.78, 0.85], gain: 0.5,
  fieldGain: 1.0, objectGain: 1.0, timeOffset: 0,
  listener: [0, 1.7, 4.4], right: [1, 0, 0],
  boundsMin: [-3, 0, -3], boundsSize: [6, 3, 6], stride: 512, objects: [],
};
