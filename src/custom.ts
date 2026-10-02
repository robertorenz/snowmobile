import { TRACKS, THEMES, ThemeName, TrackDef, CrossingKind, HazardDef } from './tracks';
import { Track } from './track';

/** What can be dropped onto a track in the editor. */
export type FeatureKind = 'jump' | 'hill' | 'rollers' | 'tunnel' | 'rockfall' | 'logs' | CrossingKind;

export const FEATURES: { kind: FeatureKind; label: string; note: string }[] = [
  { kind: 'jump', label: 'Jump', note: 'A ramp' },
  { kind: 'hill', label: 'Big hill', note: 'One tall crest' },
  { kind: 'rollers', label: 'Rollers', note: 'A run of bumps' },
  { kind: 'river', label: 'River jump', note: 'A river to clear, with a ramp' },
  { kind: 'chasm', label: 'Chasm', note: 'A wider gap to clear' },
  { kind: 'gate', label: 'Gate', note: 'A fence to jump' },
  { kind: 'highway', label: 'Highway', note: 'A road with traffic to jump' },
  { kind: 'drawbridge', label: 'Drawbridge', note: 'A bridge that lifts on a timer' },
  { kind: 'tunnel', label: 'Tunnel', note: 'About 100 m, roofed over' },
  { kind: 'rockfall', label: 'Rockfall', note: 'Boulders crossing the road' },
  { kind: 'logs', label: 'Rolling logs', note: 'Logs coming down the road' },
];

/** A track as the editor stores and shares it: small, and nothing but plain values. */
export interface CustomTrack {
  id: string;
  name: string;
  closed: boolean;
  laps: number;
  /** Road width in metres. */
  width: number;
  theme: ThemeName;
  /** Height of the mountains around the course. */
  mountain: number;
  trees: number;
  /** Rocks and logs lying on the road. */
  obstacles: number;
  /** A snowplough going round. */
  plough: boolean;
  /** Control points as [x, height, z], in metres. */
  points: [number, number, number][];
  /** Where each feature sits, as a 0..1 fraction of the length. */
  features: { kind: FeatureKind; at: number }[];
}

/** The editor's map covers this far from the centre in each direction, in metres. */
export const EDITOR_REACH = 520;
export const HEIGHT_RANGE: [number, number] = [-40, 140];

export function blankTrack(): CustomTrack {
  return {
    id: 'custom-' + Math.random().toString(36).slice(2, 9),
    name: 'My track',
    closed: true,
    laps: 2,
    width: 24,
    theme: 'day',
    mountain: 70,
    trees: 1400,
    obstacles: 4,
    plough: false,
    points: [
      [-180, 0, -120],
      [180, 0, -120],
      [260, 6, 40],
      [140, 12, 170],
      [-140, 8, 170],
      [-260, 3, 40],
    ],
    features: [],
  };
}

const hash = (s: string) => {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
  return h + 1;
};

/** Length of the course's centreline, in metres. */
function lengthOf(c: CustomTrack) {
  return new Track(bareDef(c)).length;
}

/** The course's shape alone, with nothing on it. */
function bareDef(c: CustomTrack): TrackDef {
  return {
    id: c.id,
    name: c.name,
    blurb: c.closed ? `A custom circuit, ${c.laps} lap${c.laps === 1 ? '' : 's'}.` : 'A custom point-to-point run.',
    closed: c.closed,
    laps: c.closed ? c.laps : 1,
    width: c.width,
    points: c.points,
    jumps: [],
    seed: hash(c.id),
    mountain: c.mountain,
    trees: c.trees,
    aiBonus: 0.02,
    theme: THEMES[c.theme] ?? THEMES.day,
    custom: true,
  };
}

/** Turns an editor track into one the game can build and race. */
export function toDef(c: CustomTrack): TrackDef {
  const def = bareDef(c);
  const len = lengthOf(c);
  def.obstacles = c.obstacles;
  def.rollers = [];
  def.crossings = [];
  def.tunnels = [];
  const hazards: HazardDef[] = [];
  for (const f of c.features) {
    if (f.kind === 'jump') def.jumps.push({ at: f.at, height: 1.5, length: 16 });
    else if (f.kind === 'hill') def.rollers.push({ at: f.at, length: 110, height: 10, count: 1 });
    else if (f.kind === 'rollers') def.rollers.push({ at: f.at, length: 60, height: 1.8, count: 3 });
    else if (f.kind === 'tunnel') def.tunnels.push({ from: Math.max(0, f.at - 50 / len), to: Math.min(1, f.at + 50 / len) });
    else if (f.kind === 'rockfall') hazards.push({ kind: 'rockfall', at: Math.max(0, f.at - 60 / len), length: 120, side: 1 });
    else if (f.kind === 'logs') hazards.push({ kind: 'logs', from: f.at, to: Math.min(0.98, f.at + 150 / len) });
    else def.crossings.push({ at: f.at, kind: f.kind });
  }
  if (c.plough) hazards.push({ kind: 'plough', lane: -0.8, start: 0.5 });
  def.hazards = hazards;
  // A steady pace over the whole distance, for the time-trial medals.
  def.par = Math.round((len * def.laps) / 30);
  return def;
}

export interface TrackCheck {
  length: number;
  /** Tightest corner, as a radius in metres. */
  radius: number;
  /** Steepest slope, as a fraction (0.3 is 30%). */
  grade: number;
  /** Closest that two different stretches of the course come to each other. */
  separation: number;
  /** What has to be fixed before the track can be raced; empty when it's fine. */
  problems: string[];
  /** Things worth knowing that don't stop it being raced. */
  warnings: string[];
}

/** Measures a track and says what, if anything, is wrong with it. */
export function checkTrack(c: CustomTrack): TrackCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const need = c.closed ? 4 : 3;
  if (c.points.length < need) {
    return { length: 0, radius: 0, grade: 0, separation: 0, problems: [`Add at least ${need} points.`], warnings };
  }
  const t = new Track(toDef(c));
  let k = 0;
  let grade = 0;
  for (let i = 0; i < t.n; i++) {
    k = Math.max(k, Math.abs(t.curv[i]));
    grade = Math.max(grade, Math.abs(t.slope[i]));
  }
  const radius = 1 / Math.max(k, 1e-5);
  let separation = Infinity;
  const skip = Math.round(240 / t.ds);
  for (let i = 0; i < t.n; i += 4) {
    for (let j = i + skip; j < t.n; j += 4) {
      if (t.closed && t.n - j + i < skip) continue;
      separation = Math.min(separation, Math.hypot(t.px[i] - t.px[j], t.pz[i] - t.pz[j]));
    }
  }
  if (t.length < 500) problems.push('The course is under 500 m. Spread the points out.');
  if (t.length > 5000) problems.push('The course is over 5 km. Bring the points in.');
  if (radius < 16) problems.push(`The tightest corner has a radius of ${radius.toFixed(0)} m; it needs at least 16 m. Move those points apart.`);
  if (separation < 70) problems.push(`Two stretches of the course come within ${separation.toFixed(0)} m of each other; they need 70 m. (The course can't cross itself.)`);
  if (grade > 0.6) problems.push(`The steepest slope is ${(grade * 100).toFixed(0)}%; the limit is 60%. Even out the heights.`);
  else if (grade > 0.35) warnings.push(`Steepest slope ${(grade * 100).toFixed(0)}%: expect a hard climb or a fast drop.`);
  if (radius >= 16 && radius < 30) warnings.push(`Tightest corner ${radius.toFixed(0)} m: a hairpin.`);
  for (const cr of t.crossings) {
    let bend = 0;
    for (let i = Math.round((cr.s - 100) / t.ds); i < (cr.s + 60) / t.ds; i++) bend = Math.max(bend, Math.abs(t.curv[t.wrap(i)]));
    if (bend > 1 / 90) warnings.push(`The ${cr.kind} at ${Math.round((cr.s / t.length) * 100)}% is on a bend. Crossings work best on a straight.`);
  }
  if (!c.closed && c.points[0][1] < c.points[c.points.length - 1][1]) warnings.push('This run climbs from start to finish. Descents are more fun.');
  return { length: t.length, radius, grade, separation, problems, warnings };
}

// ---------- Saving ----------

const KEY = 'powder-rush-tracks-v1';

export function loadCustomTracks(): CustomTrack[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown[]) : [];
    return list.map(clean).filter((c): c is CustomTrack => !!c);
  } catch {
    return [];
  }
}

export function saveCustomTracks(list: CustomTrack[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage full or unavailable: the tracks last until the page is closed.
  }
}

// ---------- The game's track list ----------

const sources = new Map<string, CustomTrack>();

/** The editor track a custom course was built from, for sending to other players. */
export const customSource = (id: string) => sources.get(id);

/** Adds a custom track to the game's list, or replaces the one with the same id. Returns its index. */
export function registerTrack(c: CustomTrack) {
  const def = toDef(c);
  sources.set(c.id, c);
  const at = TRACKS.findIndex((t) => t.id === c.id);
  if (at >= 0) {
    TRACKS[at] = def;
    return at;
  }
  TRACKS.push(def);
  return TRACKS.length - 1;
}

export function unregisterTrack(id: string) {
  const at = TRACKS.findIndex((t) => t.id === id && t.custom);
  if (at >= 0) TRACKS.splice(at, 1);
  sources.delete(id);
}

// ---------- Sharing ----------

const PREFIX = 'PR1.';
const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Checks something that claims to be a track (from storage, a share code or another player) and returns a safe copy, or null. */
export function clean(input: unknown): CustomTrack | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  if (!Array.isArray(o.points) || o.points.length < 3 || o.points.length > 60) return null;
  const points: [number, number, number][] = [];
  for (const p of o.points) {
    if (!Array.isArray(p) || p.length < 3) return null;
    points.push([
      Math.round(num(p[0], -EDITOR_REACH, EDITOR_REACH, 0)),
      Math.round(num(p[1], HEIGHT_RANGE[0], HEIGHT_RANGE[1], 0)),
      Math.round(num(p[2], -EDITOR_REACH, EDITOR_REACH, 0)),
    ]);
  }
  const kinds = new Set(FEATURES.map((f) => f.kind));
  const features = (Array.isArray(o.features) ? o.features : [])
    .filter((f): f is { kind: FeatureKind; at: number } => !!f && typeof f === 'object' && kinds.has((f as { kind: FeatureKind }).kind) && typeof (f as { at: unknown }).at === 'number')
    .slice(0, 24)
    .map((f) => ({ kind: f.kind, at: Math.round(num(f.at, 0.02, 0.98, 0.5) * 1000) / 1000 }));
  const id = typeof o.id === 'string' && /^custom-[a-z0-9]{3,12}$/.test(o.id) ? o.id : blankTrack().id;
  return {
    id,
    name: (typeof o.name === 'string' ? o.name : 'Custom track').replace(/[<>&"']/g, '').trim().slice(0, 24) || 'Custom track',
    closed: o.closed !== false,
    laps: Math.round(num(o.laps, 1, 5, 2)),
    width: Math.round(num(o.width, 16, 34, 24)),
    theme: typeof o.theme === 'string' && o.theme in THEMES ? (o.theme as ThemeName) : 'day',
    mountain: Math.round(num(o.mountain, 20, 140, 70)),
    trees: Math.round(num(o.trees, 200, 2200, 1400)),
    obstacles: Math.round(num(o.obstacles, 0, 10, 4)),
    plough: o.plough === true,
    points,
    features,
  };
}

/** A track as a line of text to send to a friend. */
export function toCode(c: CustomTrack) {
  const json = JSON.stringify(c);
  return PREFIX + btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Reads a share code back into a track. Null if it isn't one. */
export function fromCode(code: string): CustomTrack | null {
  const text = code.trim();
  if (!text.startsWith(PREFIX)) return null;
  try {
    const b64 = text.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    return clean(JSON.parse(decodeURIComponent(escape(atob(b64)))));
  } catch {
    return null;
  }
}
