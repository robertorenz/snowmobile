import { ALL_SURFACES } from './tracks';
import type { Difficulty, SurfaceOptions } from './tracks';

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
  /** Rear-view mirror shown while racing. */
  mirror: boolean;
  /** Id of the chosen snowmobile. */
  sled: string;
  /** Which surface patches appear on the tracks. */
  surfaces: SurfaceOptions;
  /** Name shown to other players online. */
  playerName: string;
  /** Keyed by `${trackId}:${difficulty}`. */
  results: Record<string, TrackResult>;
}

const DEFAULTS: SaveData = { unlocked: 1, difficulty: 'easy', lastTrack: 0, muted: false, mirror: true, sled: 'trailblazer', surfaces: { ...ALL_SURFACES }, playerName: '', results: {} };

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // Storage unavailable or corrupt: start fresh.
  }
  return { ...DEFAULTS, surfaces: { ...ALL_SURFACES }, results: {} };
}

export function writeSave(save: SaveData) {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    // Progress simply won't persist.
  }
}

export const resultKey = (trackId: string, difficulty: Difficulty) => `${trackId}:${difficulty}`;
