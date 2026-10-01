export interface Theme {
  skyTop: number;
  skyHorizon: number;
  fog: number;
  fogNear: number;
  fogFar: number;
  sun: number;
  sunIntensity: number;
  sunDir: [number, number, number];
  ambientSky: number;
  ambientGround: number;
  ambientIntensity: number;
  snowTint: number;
  trackTint: number;
  snowfall: number;
  wind: [number, number, number];
  stars: boolean;
  aurora: boolean;
  night: boolean;
  exposure: number;
}

export interface JumpDef {
  /** Position along the track as a 0..1 fraction of its length. */
  at: number;
  height: number;
  length: number;
}

export interface TrackDef {
  id: string;
  name: string;
  blurb: string;
  /** Circuits are closed loops raced in laps; open tracks are point-to-point descents. */
  closed: boolean;
  laps: number;
  width: number;
  /** Centerline control points as [x, y, z]; y is the track elevation. */
  points: [number, number, number][];
  jumps: JumpDef[];
  seed: number;
  /** Height of the mountains that rise away from the track. */
  mountain: number;
  trees: number;
  /** Extra AI pace on later levels. */
  aiBonus: number;
  theme: Theme;
}

const DAY: Theme = {
  skyTop: 0x2f78c8,
  skyHorizon: 0xcfe4f3,
  fog: 0xcfe4f3,
  fogNear: 220,
  fogFar: 1300,
  sun: 0xfff1d6,
  sunIntensity: 3.4,
  sunDir: [0.55, 0.62, 0.35],
  ambientSky: 0xbfdcff,
  ambientGround: 0xf2f6fa,
  ambientIntensity: 1.9,
  snowTint: 0xf4f8fc,
  trackTint: 0xd3e2f0,
  snowfall: 700,
  wind: [2, -6, 1],
  stars: false,
  aurora: false,
  night: false,
  exposure: 1.05,
};

const GOLDEN: Theme = {
  ...DAY,
  skyTop: 0x35618f,
  skyHorizon: 0xffc992,
  fog: 0xf6cfa6,
  fogNear: 180,
  fogFar: 1100,
  sun: 0xffb36b,
  sunIntensity: 2.8,
  sunDir: [-0.7, 0.28, 0.45],
  ambientSky: 0x9cc0e8,
  ambientGround: 0xffe2c4,
  ambientIntensity: 1.7,
  snowTint: 0xfff3e6,
  trackTint: 0xecdccb,
  snowfall: 400,
};

const GLACIER: Theme = {
  ...DAY,
  skyTop: 0x1563c0,
  skyHorizon: 0xdff0fb,
  fog: 0xdff0fb,
  fogNear: 300,
  fogFar: 1700,
  sunDir: [-0.4, 0.75, -0.3],
  sunIntensity: 2.9,
  snowTint: 0xeef7ff,
  trackTint: 0xc3dcf2,
  snowfall: 250,
};

const NIGHT: Theme = {
  skyTop: 0x030814,
  skyHorizon: 0x10304c,
  fog: 0x0c2439,
  fogNear: 90,
  fogFar: 800,
  sun: 0xa9c8ff,
  sunIntensity: 1.1,
  sunDir: [0.35, 0.7, -0.5],
  ambientSky: 0x3f6fa8,
  ambientGround: 0x1d3a55,
  ambientIntensity: 1.1,
  snowTint: 0xdcebf8,
  trackTint: 0xb4cde6,
  snowfall: 500,
  wind: [1.5, -5, 0.5],
  stars: true,
  aurora: true,
  night: true,
  exposure: 1.1,
};

const BLIZZARD: Theme = {
  skyTop: 0x9fb0bd,
  skyHorizon: 0xd3dce3,
  fog: 0xd3dce3,
  fogNear: 35,
  fogFar: 360,
  sun: 0xffffff,
  sunIntensity: 1.3,
  sunDir: [0.3, 0.8, 0.3],
  ambientSky: 0xdfe8ef,
  ambientGround: 0xeef2f5,
  ambientIntensity: 1.7,
  snowTint: 0xf2f5f8,
  trackTint: 0xcfdbe6,
  snowfall: 6000,
  wind: [13, -8, 4],
  stars: false,
  aurora: false,
  night: false,
  exposure: 0.85,
};

export const TRACKS: TrackDef[] = [
  {
    id: 'pine-meadow',
    name: 'Pine Meadow',
    blurb: 'A wide, flowing loop through the pines. Learn the sled here.',
    closed: true,
    laps: 3,
    width: 26,
    points: [
      [0, 0, 0],
      [130, 0, 0],
      [230, 1, 40],
      [260, 3, 140],
      [200, 4, 230],
      [90, 3, 250],
      [0, 2, 200],
      [-100, 1, 250],
      [-220, 0, 230],
      [-280, -1, 130],
      [-240, -1, 30],
      [-130, 0, 0],
    ],
    jumps: [{ at: 0.45, height: 1.6, length: 16 }],
    seed: 11,
    mountain: 70,
    trees: 1700,
    aiBonus: 0,
    theme: DAY,
  },
  {
    id: 'frostbite-ridge',
    name: 'Frostbite Ridge',
    blurb: 'Climb the ridge at golden hour. Two jumps and a fast descent.',
    closed: true,
    laps: 2,
    width: 23,
    points: [
      [0, 0, 0],
      [140, 2, 0],
      [260, 6, -40],
      [340, 12, -140],
      [320, 18, -260],
      [220, 22, -320],
      [120, 20, -270],
      [80, 14, -170],
      [-20, 10, -130],
      [-120, 12, -200],
      [-180, 16, -310],
      [-290, 14, -340],
      [-380, 8, -260],
      [-390, 4, -130],
      [-320, 1, -30],
      [-180, 0, 0],
    ],
    jumps: [
      { at: 0.2, height: 2.4, length: 18 },
      { at: 0.63, height: 2.2, length: 18 },
    ],
    seed: 23,
    mountain: 110,
    trees: 1900,
    aiBonus: 0.01,
    theme: GOLDEN,
  },
  {
    id: 'glacier-run',
    name: 'Glacier Run',
    blurb: 'Point-to-point down the glacier. Gravity is on your side.',
    closed: false,
    laps: 1,
    width: 24,
    points: [
      [0, 260, 0],
      [0, 252, 120],
      [40, 240, 260],
      [130, 225, 380],
      [170, 210, 520],
      [110, 196, 660],
      [0, 184, 760],
      [-110, 170, 860],
      [-170, 154, 1000],
      [-120, 140, 1150],
      [-10, 128, 1260],
      [80, 112, 1380],
      [90, 96, 1520],
      [10, 82, 1650],
      [-90, 66, 1760],
      [-130, 50, 1900],
      [-70, 34, 2040],
      [20, 20, 2160],
      [40, 8, 2300],
      [40, 0, 2440],
      [40, -2, 2580],
    ],
    jumps: [
      { at: 0.3, height: 2.6, length: 18 },
      { at: 0.55, height: 2.8, length: 20 },
      { at: 0.8, height: 2.6, length: 18 },
    ],
    seed: 37,
    mountain: 120,
    trees: 1500,
    aiBonus: 0.02,
    theme: GLACIER,
  },
  {
    id: 'aurora-pass',
    name: 'Aurora Pass',
    blurb: 'A technical night circuit under the northern lights.',
    closed: true,
    laps: 2,
    width: 21,
    points: [
      [0, 0, 0],
      [110, 0, 0],
      [200, 3, 50],
      [210, 8, 150],
      [130, 12, 210],
      [40, 10, 160],
      [-50, 8, 210],
      [-60, 12, 320],
      [30, 18, 400],
      [150, 22, 390],
      [270, 20, 440],
      [330, 14, 540],
      [270, 8, 640],
      [150, 6, 650],
      [60, 10, 570],
      [-60, 14, 600],
      [-170, 12, 540],
      [-220, 8, 420],
      [-200, 4, 290],
      [-230, 2, 160],
      [-200, 0, 50],
      [-110, 0, 0],
    ],
    jumps: [
      { at: 0.78, height: 2.0, length: 16 },
      { at: 0.975, height: 2.0, length: 16 },
    ],
    seed: 51,
    mountain: 100,
    trees: 2100,
    aiBonus: 0.03,
    theme: NIGHT,
  },
  {
    id: 'whiteout-summit',
    name: 'Whiteout Summit',
    blurb: 'A long, steep descent through a blizzard. Trust the marker poles.',
    closed: false,
    laps: 1,
    width: 23,
    points: [
      [0, 380, 0],
      [0, 370, 110],
      [-60, 352, 230],
      [-170, 334, 300],
      [-260, 316, 400],
      [-250, 300, 530],
      [-150, 286, 610],
      [-30, 270, 650],
      [90, 254, 720],
      [160, 238, 830],
      [140, 222, 960],
      [40, 208, 1040],
      [-80, 194, 1090],
      [-190, 178, 1170],
      [-230, 160, 1300],
      [-170, 144, 1420],
      [-50, 130, 1480],
      [70, 114, 1540],
      [170, 98, 1640],
      [190, 82, 1780],
      [120, 68, 1900],
      [0, 56, 1970],
      [-110, 42, 2060],
      [-150, 28, 2200],
      [-90, 16, 2330],
      [10, 8, 2430],
      [60, 2, 2560],
      [60, -2, 2700],
      [60, -4, 2840],
    ],
    jumps: [
      { at: 0.22, height: 2.4, length: 18 },
      { at: 0.47, height: 2.8, length: 20 },
      { at: 0.66, height: 2.6, length: 18 },
      { at: 0.86, height: 2.4, length: 18 },
    ],
    seed: 67,
    mountain: 110,
    trees: 1500,
    aiBonus: 0.04,
    theme: BLIZZARD,
  },
];

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface DifficultyDef {
  label: string;
  blurb: string;
  /** Range of AI top speed as a fraction of the sled's top speed. */
  speed: [number, number];
  /** How close to the grip limit the AI corners (1 = limit). */
  corner: number;
  /** How readily the AI uses boost on straights (0 = never). */
  boost: number;
  /** Steering wobble. */
  error: number;
  /** How strongly AI pace bends toward the player's position. */
  rubber: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyDef> = {
  easy: {
    label: 'Easy',
    blurb: 'Relaxed rivals that leave you room.',
    speed: [0.78, 0.86],
    corner: 0.7,
    boost: 0,
    error: 0.6,
    rubber: 0.07,
  },
  medium: {
    label: 'Medium',
    blurb: 'A fair fight. Clean lines win.',
    speed: [0.87, 0.95],
    corner: 0.84,
    boost: 0.35,
    error: 0.3,
    rubber: 0.04,
  },
  hard: {
    label: 'Hard',
    blurb: 'Fast, precise and they use boost.',
    speed: [0.95, 1.01],
    corner: 0.96,
    boost: 0.8,
    error: 0.1,
    rubber: 0.025,
  },
};
