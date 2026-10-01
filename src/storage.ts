import { ALL_SURFACES } from './tracks';
import type { Difficulty, SurfaceOptions } from './tracks';
import type { UpgradeLevels } from './sleds';
import type { Quality } from './quality';

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
  /** Graphics level, or 'auto' to choose from the computer's hardware. */
  quality: Quality | 'auto';
  music: boolean;
  /** Coins won, the paints bought with them, and the one in use. */
  coins: number;
  paints: string[];
  paint: string;
  upgrades: UpgradeLevels;
  /** Hood stripe colour, or -1 for the model's own. */
  stripe: number;
  /** What the Race button starts. */
  mode: GameMode;
  cup: number;
  /** Best time-trial time per track id. */
  trials: Record<string, number>;
  /** Best final position per cup id. */
  cups: Record<string, number>;
  /** Chase camera behind the sled, the rider's-eye view, or looking straight down from above. */
  camera: 'chase' | 'rider' | 'top';
  /** How high the bird's-eye view sits: 1 is the standard height, up to 4 times that. */
  topZoom: number;
  /** Id of the chosen snowmobile. */
  sled: string;
  /** Which surface patches appear on the tracks. */
  surfaces: SurfaceOptions;
  /** Name shown to other players online. */
  playerName: string;
  /** Keyed by `${trackId}:${difficulty}`. */
  results: Record<string, TrackResult>;
}

const DEFAULTS: SaveData = { unlocked: 1, difficulty: 'easy', lastTrack: 0, muted: false, mirror: true, quality: 'auto', music: true, coins: 0, paints: ['amber'], paint: 'amber', upgrades: { engine: 0, turbo: 0, skis: 0 }, stripe: -1, mode: 'race', cup: 0, trials: {}, cups: {}, camera: 'chase', topZoom: 1, sled: 'trailblazer', surfaces: { ...ALL_SURFACES }, playerName: '', results: {} };

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
