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
  /** Green meadow: grass instead of snow, with snow only on the road. */
  meadow?: boolean;
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
  /** Width keyframes as [fraction of track length, width]; the width eases between them. */
  widths?: [number, number][];
  /** Runs of rounded bumps. */
  rollers?: { at: number; length: number; height: number; count: number }[];
  /** Number of obstacles scattered on the racing surface. */
  obstacles?: number;
  /** A river running beside part of the course. side: 1 = left of travel, -1 = right; gap is from the track edge to mid-river. */
  river?: { from: number; to: number; side: 1 | -1; gap: number; width: number };
  /** A frozen lake: an ellipse of flat, slippery ice at height y. */
  lake?: { x: number; z: number; rx: number; rz: number; y: number };
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

const MEADOW: Theme = {
  ...DAY,
  skyTop: 0x3b86d6,
  skyHorizon: 0xd6ecf7,
  fog: 0xd6ecf7,
  fogNear: 260,
  fogFar: 1500,
  sunIntensity: 3.0,
  sunDir: [0.4, 0.7, -0.45],
  ambientGround: 0xcfe3b0,
  ambientIntensity: 1.5,
  // The ground is grass here; only the road keeps its snow.
  snowTint: 0x6f9c48,
  trackTint: 0xf2f7fb,
  snowfall: 0,
  meadow: true,
  exposure: 1.0,
};

export const TRACKS: TrackDef[] = [
  {
    id: 'pine-meadow',
    name: 'Pine Meadow',
    blurb: 'A rolling loop through the pines. Learn the sled here.',
    closed: true,
    laps: 3,
    width: 26,
    points: [
      [0, 0, 0],
      [130, 0, 0],
      [230, 3, 40],
      [265, 9, 140],
      [205, 14, 235],
      [100, 11, 268],
      [0, 5, 195],
      [-100, 9, 268],
      [-220, 13, 232],
      [-282, 7, 130],
      [-240, 2, 30],
      [-130, 0, 0],
    ],
    widths: [
      [0, 26],
      [0.22, 32],
      [0.42, 19],
      [0.6, 30],
      [0.82, 20],
    ],
    jumps: [
      { at: 0.3, height: 1.3, length: 16 },
      { at: 0.72, height: 1.2, length: 16 },
    ],
    rollers: [
      { at: 0.55, length: 60, height: 1.8, count: 3 },
      { at: 0.86, length: 120, height: 6, count: 1 },
    ],
    river: { from: 0.28, to: 0.5, side: 1, gap: 19, width: 13 },
    obstacles: 4,
    seed: 11,
    mountain: 70,
    trees: 1700,
    aiBonus: 0,
    theme: DAY,
  },
  {
    id: 'frostbite-ridge',
    name: 'Frostbite Ridge',
    blurb: 'Climb the ridge at golden hour, then drop off the far side. Four jumps.',
    closed: true,
    laps: 2,
    width: 23,
    points: [
      [0, 0, 0],
      [140, 3, 0],
      [260, 10, -40],
      [340, 22, -140],
      [320, 34, -260],
      [220, 40, -320],
      [120, 34, -270],
      [80, 24, -170],
      [-20, 16, -130],
      [-120, 22, -200],
      [-180, 32, -310],
      [-290, 28, -340],
      [-380, 16, -260],
      [-390, 8, -130],
      [-320, 2, -30],
      [-180, 0, 0],
    ],
    widths: [
      [0, 23],
      [0.17, 30],
      [0.33, 16],
      [0.52, 27],
      [0.68, 15],
      [0.88, 28],
    ],
    jumps: [
      { at: 0.44, height: 1.5, length: 18 },
      { at: 0.63, height: 1.2, length: 18 },
      { at: 0.83, height: 1.6, length: 18 },
      { at: 0.96, height: 1.6, length: 18 },
    ],
    rollers: [
      { at: 0.18, length: 60, height: 1.8, count: 3 },
      { at: 0.52, length: 70, height: 2, count: 3 },
      { at: 0.3, length: 150, height: 11, count: 1 },
    ],
    obstacles: 7,
    seed: 23,
    mountain: 110,
    trees: 1900,
    aiBonus: 0.01,
    theme: GOLDEN,
  },
  {
    id: 'glacier-run',
    name: 'Glacier Run',
    blurb: 'Point-to-point down the glacier: sweeping bends, squeezes and five jumps.',
    closed: false,
    laps: 1,
    width: 24,
    points: [
      [0, 260, 0],
      [0, 252, 120],
      [56, 240, 260],
      [182, 225, 380],
      [238, 210, 520],
      [154, 196, 660],
      [0, 184, 760],
      [-154, 170, 860],
      [-238, 154, 1000],
      [-168, 140, 1150],
      [-14, 128, 1260],
      [112, 112, 1380],
      [126, 96, 1520],
      [14, 82, 1650],
      [-126, 66, 1760],
      [-182, 50, 1900],
      [-98, 34, 2040],
      [28, 20, 2160],
      [56, 8, 2300],
      [56, 0, 2440],
      [56, -2, 2580],
    ],
    widths: [
      [0, 24],
      [0.18, 34],
      [0.36, 15],
      [0.55, 28],
      [0.72, 16],
      [0.9, 26],
    ],
    jumps: [
      { at: 0.14, height: 1.8, length: 18 },
      { at: 0.3, height: 1.8, length: 18 },
      { at: 0.46, height: 2, length: 20 },
      { at: 0.62, height: 1.8, length: 18 },
      { at: 0.8, height: 1.8, length: 18 },
    ],
    rollers: [
      { at: 0.22, length: 70, height: 2, count: 3 },
      { at: 0.68, length: 80, height: 2.2, count: 4 },
    ],
    obstacles: 10,
    seed: 37,
    mountain: 120,
    trees: 1500,
    aiBonus: 0.02,
    theme: GLACIER,
  },
  {
    id: 'aurora-pass',
    name: 'Aurora Pass',
    blurb: 'A technical night circuit over the pass, under the northern lights.',
    closed: true,
    laps: 2,
    width: 21,
    points: [
      [0, 0, 0],
      [110, 0, 0],
      [200, 5, 50],
      [210, 14, 150],
      [130, 22, 210],
      [40, 18, 160],
      [-50, 14, 210],
      [-60, 22, 320],
      [30, 32, 400],
      [150, 40, 390],
      [270, 36, 440],
      [330, 25, 540],
      [270, 14, 640],
      [150, 11, 650],
      [60, 18, 570],
      [-60, 25, 600],
      [-170, 22, 540],
      [-220, 14, 420],
      [-200, 7, 290],
      [-230, 4, 160],
      [-200, 0, 50],
      [-110, 0, 0],
    ],
    widths: [
      [0, 21],
      [0.15, 15],
      [0.32, 26],
      [0.5, 14],
      [0.66, 24],
      [0.85, 16],
    ],
    jumps: [
      { at: 0.22, height: 1.0, length: 16 },
      { at: 0.78, height: 1.4, length: 16 },
      { at: 0.975, height: 1.4, length: 16 },
    ],
    rollers: [
      { at: 0.36, length: 60, height: 1.8, count: 3 },
      { at: 0.7, length: 50, height: 1.6, count: 3 },
    ],
    obstacles: 9,
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
      [-75, 352, 230],
      [-212, 334, 300],
      [-325, 316, 400],
      [-312, 300, 530],
      [-188, 286, 610],
      [-38, 270, 650],
      [112, 254, 720],
      [200, 238, 830],
      [175, 222, 960],
      [50, 208, 1040],
      [-100, 194, 1090],
      [-238, 178, 1170],
      [-288, 160, 1300],
      [-212, 144, 1420],
      [-62, 130, 1480],
      [88, 114, 1540],
      [212, 98, 1640],
      [238, 82, 1780],
      [150, 68, 1900],
      [0, 56, 1970],
      [-138, 42, 2060],
      [-188, 28, 2200],
      [-112, 16, 2330],
      [12, 8, 2430],
      [75, 2, 2560],
      [75, -2, 2700],
      [75, -4, 2840],
    ],
    widths: [
      [0, 23],
      [0.12, 30],
      [0.27, 16],
      [0.45, 28],
      [0.6, 16],
      [0.78, 28],
      [0.94, 20],
    ],
    jumps: [
      { at: 0.12, height: 1.7, length: 18 },
      { at: 0.22, height: 1.7, length: 18 },
      { at: 0.36, height: 1.8, length: 18 },
      { at: 0.44, height: 1.8, length: 20 },
      { at: 0.66, height: 1.8, length: 18 },
      { at: 0.78, height: 1.7, length: 18 },
      { at: 0.84, height: 1.5, length: 18 },
    ],
    rollers: [
      { at: 0.4, length: 70, height: 2, count: 4 },
      { at: 0.72, length: 60, height: 1.8, count: 3 },
    ],
    obstacles: 14,
    seed: 67,
    mountain: 110,
    trees: 1500,
    aiBonus: 0.04,
    theme: BLIZZARD,
  },
  {
    id: 'thaw-meadow',
    name: 'Thaw Meadow',
    blurb: 'Spring has reached the valley. Only the road still holds snow, and a river runs beside it.',
    closed: true,
    laps: 2,
    width: 22,
    points: [
      [0, 0, 0],
      [140, 0, 0],
      [250, 4, 50],
      [290, 10, 160],
      [230, 6, 260],
      [120, 2, 300],
      [20, 6, 240],
      [-70, 12, 300],
      [-170, 10, 380],
      [-290, 4, 360],
      [-350, 0, 260],
      [-320, 2, 150],
      [-250, 6, 60],
      [-140, 2, 0],
    ],
    widths: [
      [0, 22],
      [0.2, 28],
      [0.4, 16],
      [0.62, 26],
      [0.85, 17],
    ],
    jumps: [
      { at: 0.42, height: 1.4, length: 16 },
      { at: 0.975, height: 1.2, length: 16 },
    ],
    rollers: [
      { at: 0.55, length: 130, height: 9, count: 1 },
      { at: 0.76, length: 64, height: 1.8, count: 4 },
    ],
    river: { from: 0.02, to: 0.34, side: 1, gap: 19, width: 14 },
    obstacles: 6,
    seed: 79,
    mountain: 60,
    trees: 1500,
    aiBonus: 0.02,
    theme: MEADOW,
  },
  {
    id: 'mirror-lake',
    name: 'Mirror Lake',
    blurb: 'Straight across a frozen lake. The ice is fast and has almost no grip.',
    closed: true,
    laps: 2,
    width: 23,
    points: [
      [0, 0, 0],
      [150, 0, 0],
      [280, 4, 60],
      [330, 8, 180],
      [280, 4, 290],
      [170, 0, 300],
      [0, 0, 312],
      [-170, 0, 300],
      [-290, 5, 280],
      [-360, 12, 180],
      [-330, 8, 60],
      [-220, 2, 0],
      [-110, 0, 0],
    ],
    widths: [
      [0, 23],
      [0.2, 17],
      [0.45, 30],
      [0.7, 18],
      [0.9, 26],
    ],
    jumps: [{ at: 0.96, height: 1.4, length: 16 }],
    rollers: [
      { at: 0.05, length: 60, height: 1.8, count: 3 },
      { at: 0.74, length: 140, height: 9, count: 1 },
    ],
    lake: { x: 0, z: 308, rx: 205, rz: 92, y: 0 },
    river: { from: 0.12, to: 0.24, side: 1, gap: 19, width: 13 },
    obstacles: 7,
    seed: 83,
    mountain: 90,
    trees: 1700,
    aiBonus: 0.03,
    theme: GLACIER,
  },
  {
    id: 'switchback-pass',
    name: 'Switchback Pass',
    blurb: 'Twist up a mountain and plunge off the far side. Steep enough to bog you down.',
    closed: true,
    laps: 2,
    width: 21,
    points: [
      [0, 0, 0],
      [130, 0, 0],
      [250, 8, 30],
      [320, 22, 120],
      [290, 38, 230],
      [190, 50, 270],
      [90, 58, 220],
      [0, 68, 270],
      [-90, 82, 340],
      [-200, 92, 330],
      [-290, 86, 250],
      [-360, 66, 160],
      [-345, 40, 60],
      [-270, 16, 5],
      [-150, 2, 0],
    ],
    widths: [
      [0, 21],
      [0.18, 26],
      [0.36, 15],
      [0.55, 24],
      [0.75, 15],
      [0.92, 24],
    ],
    jumps: [
      { at: 0.6, height: 1.5, length: 16 },
      { at: 0.955, height: 1.5, length: 16 },
    ],
    rollers: [
      { at: 0.22, length: 120, height: 8, count: 1 },
      { at: 0.4, length: 110, height: 7, count: 1 },
      { at: 0.03, length: 54, height: 1.8, count: 3 },
    ],
    obstacles: 8,
    seed: 97,
    mountain: 130,
    trees: 1800,
    aiBonus: 0.04,
    theme: GOLDEN,
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
