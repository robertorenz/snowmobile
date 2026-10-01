/** How a snowmobile is proportioned. All values are multipliers on the standard sled unless noted. */
export interface SledShape {
  length: number;
  width: number;
  /** Height of the hull and hood. */
  height: number;
  /** Extra reach of the nose, in metres, and how far it droops (0 blunt and high, 1 low and pointed). */
  nose: number;
  droop: number;
  /** Half the distance between the skis, in metres. */
  stance: number;
  /** Ski width. */
  ski: number;
  windshield: number;
  /** A cargo box behind the seat. */
  cargo: boolean;
  /** A tail fin. */
  fin: boolean;
  /** Colour of the hood stripe. */
  stripe: number;
}

/** A snowmobile the player can choose: how it looks and how it drives. */
export interface SledSpec {
  id: string;
  name: string;
  blurb: string;
  /** Top speed, acceleration, steering, and grip (low grip slides), each relative to the Trailblazer. */
  speed: number;
  accel: number;
  turn: number;
  grip: number;
  /** How much of its speed it keeps in deep snow off the course (0.58 is standard). */
  offroad: number;
  /** How hard stone and grass slow it: 1 is standard, lower shrugs them off. */
  rough: number;
  shape: SledShape;
}

const STANDARD: SledShape = {
  length: 1,
  width: 1,
  height: 1,
  nose: 0,
  droop: 0.5,
  stance: 0.6,
  ski: 1,
  windshield: 1,
  cargo: false,
  fin: false,
  stripe: 0xf3f8fc,
};

export const SLEDS: SledSpec[] = [
  {
    id: 'trailblazer',
    name: 'Trailblazer',
    blurb: 'The all-rounder. No weaknesses, no surprises.',
    speed: 1,
    accel: 1,
    turn: 1,
    grip: 1,
    offroad: 0.58,
    rough: 1,
    shape: STANDARD,
  },
  {
    id: 'arrow',
    name: 'Arrow',
    blurb: 'Long, low and the fastest thing on snow. Slow to wind up, and it would rather go straight.',
    speed: 1.15,
    accel: 0.92,
    turn: 0.9,
    grip: 0.85,
    offroad: 0.5,
    rough: 1.15,
    shape: { ...STANDARD, length: 1.18, width: 0.88, height: 0.82, nose: 0.35, droop: 1, stance: 0.52, ski: 0.85, windshield: 0.6, fin: true, stripe: 0x14181d },
  },
  {
    id: 'lynx',
    name: 'Lynx',
    blurb: 'Short and light. Leaps off the line and turns on the spot, but runs out of speed early.',
    speed: 0.88,
    accel: 1.25,
    turn: 1.28,
    grip: 1.15,
    offroad: 0.6,
    rough: 1,
    shape: { ...STANDARD, length: 0.84, width: 0.94, height: 0.95, nose: -0.12, droop: 0.4, stance: 0.56, windshield: 1.15, stripe: 0xf6a821 },
  },
  {
    id: 'mammoth',
    name: 'Mammoth',
    blurb: 'A heavy hauler on wide skis. Glued to the ground, and it ploughs through powder, rock and grass.',
    speed: 0.95,
    accel: 0.8,
    turn: 0.84,
    grip: 1.5,
    offroad: 0.8,
    rough: 0.4,
    shape: { ...STANDARD, length: 1.1, width: 1.22, height: 1.18, nose: -0.05, droop: 0, stance: 0.72, ski: 1.5, windshield: 1.25, cargo: true, stripe: 0x2b3440 },
  },
  {
    id: 'drifter',
    name: 'Drifter',
    blurb: 'Loose on purpose. Quick and eager, and the tail steps out in every bend.',
    speed: 1.03,
    accel: 1.12,
    turn: 1.18,
    grip: 0.55,
    offroad: 0.55,
    rough: 1,
    shape: { ...STANDARD, length: 0.96, width: 1.08, height: 0.86, nose: 0.1, droop: 0.8, stance: 0.7, ski: 0.9, windshield: 0.75, fin: true, stripe: 0xe5484d },
  },
];

/** Paint for the player's sled. The first is free; the rest are bought with coins won racing. */
export interface Paint {
  id: string;
  name: string;
  color: number;
  price: number;
}

export const PAINTS: Paint[] = [
  { id: 'amber', name: 'Amber', color: 0xf6a821, price: 0 },
  { id: 'crimson', name: 'Crimson', color: 0xd8343a, price: 150 },
  { id: 'cobalt', name: 'Cobalt', color: 0x1e6fb0, price: 150 },
  { id: 'emerald', name: 'Emerald', color: 0x2e9e5b, price: 150 },
  { id: 'teal', name: 'Teal', color: 0x13b5c2, price: 200 },
  { id: 'ivory', name: 'Ivory', color: 0xeef3f7, price: 200 },
  { id: 'tangerine', name: 'Tangerine', color: 0xff6f3c, price: 250 },
  { id: 'graphite', name: 'Graphite', color: 0x3a4450, price: 250 },
  { id: 'gold', name: 'Gold', color: 0xd4a017, price: 500 },
];

export function paintById(id: string | undefined) {
  return PAINTS.find((p) => p.id === id) ?? PAINTS[0];
}

/** Upgrades bought with coins. Each has three levels; every level adds per to the figures it improves. Solo play only. */
export interface Upgrade {
  id: 'engine' | 'turbo' | 'skis';
  name: string;
  note: string;
  per: number;
}

export const UPGRADES: Upgrade[] = [
  { id: 'engine', name: 'Engine', note: 'Top speed', per: 0.025 },
  { id: 'turbo', name: 'Turbo', note: 'Acceleration', per: 0.04 },
  { id: 'skis', name: 'Skis', note: 'Steering and grip', per: 0.035 },
];
export const UPGRADE_PRICES = [150, 300, 500];

export type UpgradeLevels = Record<Upgrade['id'], number>;

/** Stripe colours for the hood: free to choose. The first means "the model's own". */
export const STRIPES = [-1, 0xf3f8fc, 0x14181d, 0xf6a821, 0xd8343a, 0x1e6fb0, 0x2e9e5b];

/** A model with the player's upgrades and stripe applied. */
export function tunedSled(spec: SledSpec, levels: UpgradeLevels, stripe: number): SledSpec {
  return {
    ...spec,
    speed: spec.speed * (1 + levels.engine * UPGRADES[0].per),
    accel: spec.accel * (1 + levels.turbo * UPGRADES[1].per),
    turn: spec.turn * (1 + levels.skis * UPGRADES[2].per),
    grip: spec.grip * (1 + levels.skis * UPGRADES[2].per),
    shape: stripe >= 0 ? { ...spec.shape, stripe } : spec.shape,
  };
}

/** Coins paid out by finishing place in a race, by time-trial medal, and by final position in a cup. */
export const RACE_COINS = [60, 40, 30, 20, 15, 10];
export const MEDAL_COINS = [80, 50, 30];
export const CUP_COINS = [200, 120, 80];

export const DEFAULT_SLED = SLEDS[0];

export function sledById(id: string | undefined) {
  return SLEDS.find((s) => s.id === id) ?? DEFAULT_SLED;
}
