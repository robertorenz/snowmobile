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
  /** What the Race button starts. */
  mode: GameMode;
  cup: number;
  /** Best time-trial time per track id. */
  trials: Record<string, number>;
  /** Best final position per cup id. */
  cups: Record<string, number>;
  /** Chase camera behind the sled, or the rider's-eye view. */
  camera: 'chase' | 'rider';
  /** Id of the chosen snowmobile. */
  sled: string;
  /** Which surface patches appear on the tracks. */
  surfaces: SurfaceOptions;
  /** Name shown to other players online. */
  playerName: string;
  /** Keyed by `${trackId}:${difficulty}`. */
  results: Record<string, TrackResult>;
}

const DEFAULTS: SaveData = { unlocked: 1, difficulty: 'easy', lastTrack: 0, muted: false, mirror: true, mode: 'race', cup: 0, trials: {}, cups: {}, camera: 'chase', sled: 'trailblazer', surfaces: { ...ALL_SURFACES }, playerName: '', results: {} };

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

export type GameMode = 'race' | 'trial' | 'elimination' | 'championship';

const GHOST_KEY = 'powder-rush-ghost:';

/** The saved best time-trial run on a track, if there is one. */
export function loadGhost(trackId: string): number[] | null {
  try {
    const raw = localStorage.getItem(GHOST_KEY + trackId);
    return raw ? (JSON.parse(raw) as number[]) : null;
  } catch {
    return null;
  }
}

export function saveGhost(trackId: string, data: number[]) {
  try {
    localStorage.setItem(GHOST_KEY + trackId, JSON.stringify(data));
  } catch {
    // Out of space: the time still counts, there just won't be a ghost.
  }
}

export const resultKey = (trackId: string, difficulty: Difficulty) => `${trackId}:${difficulty}`;
