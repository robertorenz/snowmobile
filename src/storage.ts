import type { Difficulty } from './tracks';

const KEY = 'powder-rush-save-v1';

export interface TrackResult {
  bestPlace: number;
  bestTime: number;
}

export interface SaveData {
  /** Number of tracks unlocked, counted from the first. */
  unlocked: number;
  difficulty: Difficulty;
  lastTrack: number;
  muted: boolean;
  /** Keyed by `${trackId}:${difficulty}`. */
  results: Record<string, TrackResult>;
}

const DEFAULTS: SaveData = { unlocked: 1, difficulty: 'easy', lastTrack: 0, muted: false, results: {} };

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // Storage unavailable or corrupt: start fresh.
  }
  return { ...DEFAULTS, results: {} };
}

export function writeSave(save: SaveData) {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    // Progress simply won't persist.
  }
}

export const resultKey = (trackId: string, difficulty: Difficulty) => `${trackId}:${difficulty}`;
