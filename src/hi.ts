// The high score: one number in localStorage under `space-raider-hi`, which Arcadia's cabinet shows too. Storage can be
// blocked (private windows, embeds), so every access is in try/catch and the game carries on without it.
import { ATTRACT } from './attract';

const KEY = 'space-raider-hi';

export function loadHi(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/** Saves `score` if it beats the stored one (never in attract mode). True if it did. */
export function saveHi(score: number): boolean {
  if (ATTRACT || score <= loadHi()) return false;
  try {
    localStorage.setItem(KEY, String(Math.floor(score)));
  } catch {
    // Blocked or full: this session just won't remember it.
  }
  return true;
}
