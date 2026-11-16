// Attract mode: `?attract` in the URL runs a silent, self-playing demo for Arcadia's cabinet screens. No title, no
// sound, no input, nothing saved. `?attract&seed=<n>` repeats a demo exactly.
const params = new URLSearchParams(location.search);

export const ATTRACT = params.has('attract');

/** The seed for the first demo: `?seed=<n>` if given, otherwise random. */
export function attractSeed(): number {
  const n = Number(params.get('seed'));
  return params.has('seed') && Number.isFinite(n) ? Math.floor(Math.abs(n)) : Math.floor(Math.random() * 2 ** 31);
}

/** A demo ends after this long, if it hasn't ended itself, s. */
export const DEMO_SECS = 45;
