import * as THREE from 'three';
import type { TrackDef, JumpDef, CrossingKind } from './tracks';
import { mulberry32, smoothstep, wrapAngle } from './util';

/** Distance between centerline samples, in metres (approximate). */
const SAMPLE_SPACING = 2;
const OPEN_START = 60;
const OPEN_RUNOFF = 100;
/** The narrowest a pinch gets: room for two sleds, barely. */
const MIN_WIDTH = 8;

/** Half the length (along the track) of the gap each kind of crossing leaves to jump. */
const CROSSING_HALF: Record<CrossingKind, number> = { river: 6, chasm: 8, highway: 7.5, gate: 0 };
/** How far past the ramp's lip a gate stands. */
const GATE_DISTANCE = 16;
/** Height of a gate's top rail: a sled lower than this when it gets there has hit it. */
export const GATE_HEIGHT = 1.6;
const RAMP: Pick<JumpDef, 'height' | 'length'> = { height: 2.1, length: 20 };
/** After a failed jump, riders restart this far before the lip, so they have a run-up. */
const RESPAWN_RUNUP = 95;

/** Something across the course that has to be jumped: see TrackDef.crossings. */
export interface Crossing {
  kind: CrossingKind;
  /** Sample at the middle of the crossing, and its path distance. */
  idx: number;
  s: number;
  half: number;
  /** Path distance of the ramp's lip. */
  lipS: number;
  /** Ground height at the crossing. */
  y: number;
}

/** What the racing surface is made of. Everything but snow changes how the sled behaves. */
export const SNOW = 0;
export const ICE = 1;
export const SHALE = 2;
export const ROCK = 3;
export const GRASS = 4;

/** Something solid sitting on the racing surface. */
export interface Obstacle {
  /** Centerline sample it sits beside. */
  idx: number;
  /** Sideways offset from the centerline (positive is left). */
  lateral: number;
  x: number;
  z: number;
  radius: number;
  kind: 'barrier' | 'boulder' | 'rock' | 'log';
  /** Logs lie at this angle to the direction of travel (radians). */
  angle: number;
}

/**
 * The race course: a spline through the track's control points, resampled to
 * evenly spaced centerline samples that everything else (terrain, AI, lap
 * counting) reads from.
 */
export class Track {
  readonly closed: boolean;
  readonly n: number;
  readonly ds: number;
  readonly length: number;
  /** Half the track's nominal width. The actual half-width varies along the course: see hw. */
  readonly halfWidth: number;
  /** Half-width of the racing surface at each sample. */
  readonly hw: Float32Array;
  readonly obstacles: Obstacle[] = [];
  readonly crossings: Crossing[] = [];
  /** Surface type at each sample (SNOW, ICE, SHALE, ROCK or GRASS). */
  readonly surface: Uint8Array;
  /** Which half of the course a patch covers: 1 left, -1 right, 0 the full width. */
  readonly surfSide: Int8Array;
  /** 0..1: how fully a patch has set in at each sample; it fades in and out at its ends. */
  readonly surfFade: Float32Array;
  /** 1 where the course is carried on a bridge over another part of itself. */
  readonly bridge: Uint8Array;
  /** 1 where the course has solid sides: on bridges and in tunnels. */
  readonly walled: Uint8Array;
  /** Sample ranges [first, last] of each bridge and each tunnel. */
  readonly bridgeSpans: [number, number][] = [];
  readonly tunnelSpans: [number, number][] = [];
  /** Every ramp on the course: the track's own jumps plus the one before each crossing. */
  readonly ramps: JumpDef[];
  /** 1 where the course runs over a highway's tarmac. */
  readonly asphalt: Uint8Array;
  /** Where a rider restarts if reset at each sample: itself, except around a crossing, where it's back before the ramp. */
  readonly respawn: Int32Array;
  /** Speed the AI holds itself to over rollers and hill crests, so it lands on the course. */
  readonly caution: Float32Array;
  /** 1 where the course runs over lake ice. Filled in once the terrain exists. */
  ice: Uint8Array = new Uint8Array(0);
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  /** Unit tangent (direction of travel) in the ground plane. */
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  /** Unit vector pointing to the left of the direction of travel. */
  readonly lx: Float32Array;
  readonly lz: Float32Array;
  /** Signed curvature; positive turns left. */
  readonly curv: Float32Array;
  readonly slope: Float32Array;
  readonly startIdx: number;
  readonly finishIdx: number;
  /** Path distance of the start line. */
  readonly startS: number;
  /** Distance from the start line to the finish, all laps included. */
  readonly raceLength: number;

  constructor(readonly def: TrackDef) {
    const pts = def.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const curve = new THREE.CatmullRomCurve3(pts, def.closed, 'centripetal');
    curve.arcLengthDivisions = 4000;
    let len = curve.getLength();
    let seg = Math.round(len / SAMPLE_SPACING);
    let sp = curve.getSpacedPoints(seg);
    if (def.slaloms?.length) {
      sp = weave(sp, def.closed, len, def.slaloms);
      seg = sp.length - 1;
      len = seg * sp[0].distanceTo(sp[1]);
    }

    this.closed = def.closed;
    this.n = def.closed ? seg : seg + 1;
    this.ds = len / seg;
    this.length = len;
    this.halfWidth = def.width / 2;

    const n = this.n;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.lx = new Float32Array(n);
    this.lz = new Float32Array(n);
    this.curv = new Float32Array(n);
    this.slope = new Float32Array(n);
    this.hw = new Float32Array(n);
    this.ice = new Uint8Array(n);
    this.caution = new Float32Array(n).fill(Infinity);

    // Width: eased between keyframes, so the course squeezes and opens up.
    const keys = [...(def.widths ?? [])].sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < n; i++) {
      let w = def.width;
      if (keys.length) {
        const u = i / n;
        let a = keys[keys.length - 1];
        let b = keys[0];
        let span = 1 - a[0] + b[0];
        let into = u >= a[0] ? u - a[0] : u + 1 - a[0];
        for (let k = 0; k < keys.length - 1; k++) {
          if (u >= keys[k][0] && u < keys[k + 1][0]) {
            a = keys[k];
            b = keys[k + 1];
            span = b[0] - a[0];
            into = u - a[0];
          }
        }
        // Point-to-point tracks don't wrap: hold the end values.
        if (!def.closed && u < keys[0][0]) w = keys[0][1];
        else if (!def.closed && u >= keys[keys.length - 1][0]) w = keys[keys.length - 1][1];
        else w = a[1] + (b[1] - a[1]) * smoothstep(0, 1, span > 0 ? into / span : 0);
      }
      // Push the contrast: squeezes become real pinches, open sections become wide.
      const base = def.width;
      w = w < base ? Math.max(MIN_WIDTH, base - (base - w) * 2.1) : base + (w - base) * 1.8;
      this.hw[i] = w / 2;
    }
    for (let i = 0; i < n; i++) {
      this.px[i] = sp[i].x;
      // Climbs and drops are exaggerated about the start line's height.
      this.py[i] = def.points[0][1] + (sp[i].y - def.points[0][1]) * (def.elevation ?? 1);
      this.pz[i] = sp[i].z;
    }

    // Crossings each get a ramp in front of them.
    this.ramps = [...def.jumps];
    for (const c of def.crossings ?? []) {
      const s = c.at * len;
      const half = CROSSING_HALF[c.kind];
      const lipS = c.kind === 'gate' ? s - GATE_DISTANCE : s - half - 3;
      this.ramps.push({ at: lipS / len, ...RAMP });
      this.crossings.push({ kind: c.kind, idx: Math.round(s / this.ds), s, half, lipS, y: 0 });
    }

    // A crossing needs speed and room: never pinch the run-up or the landing.
    for (const c of this.crossings) {
      for (let i = 0; i < n; i++) {
        const s = i * this.ds;
        if (s > c.lipS - 90 && s < c.s + c.half + 60) this.hw[i] = Math.max(this.hw[i], 9);
      }
    }
    // Pinches leave no room for error at full speed.
    for (let i = 0; i < n; i++) if (this.hw[i] < 6.5) this.caution[i] = Math.min(this.caution[i], 31);

    // Jump ramps: a rise that ends in a lip.
    for (const j of this.ramps) {
      const lip = j.at * len;
      for (let i = 0; i < n; i++) {
        const u = (i * this.ds - (lip - j.length)) / j.length;
        if (u > 0 && u <= 1) this.py[i] += j.height * u * u;
      }
    }

    // Rollers: a run of rounded bumps.
    for (const r of def.rollers ?? []) {
      const from = r.at * len;
      for (let i = 0; i < n; i++) {
        const u = (i * this.ds - from) / r.length;
        if (u > 0 && u < 1) {
          this.py[i] += r.height * 0.5 * (1 - Math.cos(u * r.count * Math.PI * 2));
          // A run of rollers is taken steadily; a single big hill only needs care up to its crest.
          if (r.count > 1) this.caution[i] = 30;
          // The taller the hill, the slower it has to be crested to land on the course.
          else if (u < 0.6) this.caution[i] = Math.max(24, 44 - r.height * 0.8);
        }
      }
    }

    this.asphalt = new Uint8Array(n);
    this.respawn = new Int32Array(n);
    for (let i = 0; i < n; i++) this.respawn[i] = i;
    for (const c of this.crossings) {
      c.y = this.py[c.idx];
      const back = Math.max(0, Math.round((c.lipS - RESPAWN_RUNUP) / this.ds));
      for (let i = 0; i < n; i++) {
        const s = i * this.ds;
        if (s > c.lipS - 26 && s < c.s + c.half + 8) this.respawn[i] = back;
        if (c.kind === 'highway' && Math.abs(s - c.s) < c.half) this.asphalt[i] = 1;
      }
    }

    // Plunges: a steep drop, paid for (on a circuit) by an equally steep climb somewhere else.
    for (const p of def.plunges ?? []) {
      for (let i = 0; i < n; i++) {
        const s = i * this.ds;
        let dy = -p.height * smoothstep(0, 1, (s - p.at * len) / p.length);
        if (p.climbAt !== undefined) dy += p.height * smoothstep(0, 1, (s - p.climbAt * len) / (p.climbLength ?? 200));
        this.py[i] += dy;
      }
    }

    // Heights are final now; crossings sit at the ground level they ended up with.
    for (const c of this.crossings) c.y = this.py[c.idx];

    // Bridges: where the course crosses itself, the higher of the two passes rides on a deck.
    this.bridge = new Uint8Array(n);
    this.walled = new Uint8Array(n);
    for (const b of def.bridges ?? []) {
      // Collect each pass through the crossing point as a run of consecutive samples.
      const runs: number[][] = [];
      for (let i = 0; i < n; i++) {
        if (Math.hypot(this.px[i] - b.x, this.pz[i] - b.z) > b.span / 2) continue;
        const last = runs[runs.length - 1];
        if (last && last[last.length - 1] === i - 1) last.push(i);
        else runs.push([i]);
      }
      if (runs.length < 2) continue;
      const mean = (r: number[]) => r.reduce((sum, i) => sum + this.py[i], 0) / r.length;
      const top = runs.reduce((a, r) => (mean(r) > mean(a) ? r : a));
      for (const i of top) {
        this.bridge[i] = this.walled[i] = 1;
        this.hw[i] = Math.min(Math.max(this.hw[i], 5.5), 7);
      }
      this.bridgeSpans.push([top[0], top[top.length - 1]]);
    }
    for (const tn of def.tunnels ?? []) {
      const a = Math.floor(tn.from * n);
      const z = Math.min(n - 1, Math.ceil(tn.to * n));
      for (let i = a; i <= z; i++) {
        this.walled[i] = 1;
        this.hw[i] = Math.min(Math.max(this.hw[i], 5), 7);
      }
      this.tunnelSpans.push([a, z]);
    }

    const yaw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = this.wrap(i - 1);
      const b = this.wrap(i + 1);
      const dx = this.px[b] - this.px[a];
      const dz = this.pz[b] - this.pz[a];
      const l = Math.hypot(dx, dz) || 1;
      this.tx[i] = dx / l;
      this.tz[i] = dz / l;
      this.lx[i] = this.tz[i];
      this.lz[i] = -this.tx[i];
      yaw[i] = Math.atan2(dx, dz);
      this.slope[i] = (this.py[b] - this.py[a]) / (l || 1);
    }

    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = this.wrap(i - 1);
      const b = this.wrap(i + 1);
      raw[i] = a === b ? 0 : wrapAngle(yaw[b] - yaw[a]) / (2 * this.ds);
    }
    const R = 4;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -R; k <= R; k++) sum += raw[this.wrap(i + k)];
      this.curv[i] = sum / (2 * R + 1);
    }

    if (this.closed) {
      this.startIdx = 0;
      this.finishIdx = 0;
      this.startS = 0;
      this.raceLength = len * def.laps;
    } else {
      this.startIdx = Math.round(OPEN_START / this.ds);
      this.finishIdx = Math.round((len - OPEN_RUNOFF) / this.ds);
      this.startS = this.startIdx * this.ds;
      this.raceLength = (this.finishIdx - this.startIdx) * this.ds;
    }
    this.placeObstacles();
    this.surface = new Uint8Array(n);
    this.surfSide = new Int8Array(n);
    this.surfFade = new Float32Array(n);
    this.placeSurfaces();
  }

  /** The surface a sled at sample i, offset sideways by lateral, is riding on. */
  surfaceAt(i: number, lateral: number) {
    const s = this.surface[i];
    if (!s || this.surfFade[i] < 0.35) return SNOW;
    const side = this.surfSide[i];
    return side === 0 || lateral * side > 0 ? s : SNOW;
  }

  /** Lays patches of ice, shale, bare rock and grass along the course: the same every time for a given track. */
  private placeSurfaces() {
    const def = this.def;
    const rnd = mulberry32(def.seed * 977 + 5);
    const len = this.length;
    const from = this.startS + 110;
    const to = (this.closed ? len : this.finishIdx * this.ds) - 110;
    const want = Math.round(len / 240);
    const taken: [number, number][] = [];
    let made = 0;
    let tries = 0;
    while (made < want && tries++ < 3000) {
      const length = 35 + rnd() * 70;
      const s0 = from + rnd() * (to - from - length);
      const s1 = s0 + length;
      if (taken.some(([a, b]) => s0 < b + 25 && s1 > a - 25)) continue;
      // Keep jumps, crossings, bridges, tunnels and the frozen lake as they are.
      if (this.ramps.some((j) => s1 > j.at * len - 110 && s0 < j.at * len + 90)) continue;
      const a = Math.round(s0 / this.ds);
      const b = Math.min(this.n - 1, Math.round(s1 / this.ds));
      let clear = true;
      for (let i = a; i <= b && clear; i++) {
        if (this.walled[i] || this.asphalt[i]) clear = false;
        const lake = def.lake;
        if (lake && Math.hypot((this.px[i] - lake.x) / lake.rx, (this.pz[i] - lake.z) / lake.rz) < 1.15) clear = false;
      }
      if (!clear) continue;

      // Thawed ground shows more grass and stone; deep winter, more ice.
      const pick = rnd();
      const meadow = !!def.theme.meadow;
      let type = meadow
        ? pick < 0.15 ? ICE : pick < 0.45 ? SHALE : pick < 0.65 ? ROCK : GRASS
        : pick < 0.3 ? ICE : pick < 0.57 ? SHALE : pick < 0.8 ? ROCK : GRASS;
      // Ice on a tight bend is unrideable: put gravel there instead. On a gentle bend, the AI is told to arrive slowly,
      // since it can't brake once it's on the ice.
      let bend = 0;
      for (let i = a; i <= b; i++) bend = Math.max(bend, Math.abs(this.curv[i]));
      if (type === ICE && bend > 0.011) type = SHALE;
      if (type === ICE && bend > 0.0035) {
        for (let i = Math.max(0, a - 28); i <= b; i++) this.caution[i] = Math.min(this.caution[i], 29);
      }
      // Half-width patches leave a line round them, if the course is wide enough to offer one.
      const roomy = this.hw[(a + b) >> 1] >= 7;
      const sidePick = rnd();
      const side = !roomy || sidePick < (type === ICE ? 0.6 : 0.35) ? 0 : sidePick < 0.7 ? 1 : -1;
      for (let i = a; i <= b; i++) {
        this.surface[i] = type;
        this.surfSide[i] = side;
        const edge = Math.min(i - a, b - i) * this.ds;
        this.surfFade[i] = smoothstep(0, 7, edge);
      }
      taken.push([s0, s1]);
      made++;
    }
  }

  /** Scatters obstacles along the course: same places every time, clear of the grid and of jump landings. */
  private placeObstacles() {
    const def = this.def;
    const rnd = mulberry32(def.seed * 131 + 7);
    const len = this.length;
    const from = this.startS + 160;
    const to = this.closed ? len - 120 : this.finishIdx * this.ds - 120;
    const taken: number[] = [];
    let tries = 0;
    const count = Math.round((def.obstacles ?? 0) * 1.5);
    while (this.obstacles.length < count && tries++ < 4000) {
      const s = from + rnd() * (to - from);
      if (taken.some((t) => Math.abs(t - s) < 70)) continue;
      // Keep run-ups and landing zones clear.
      if (this.ramps.some((j) => s > j.at * len - 130 && s < j.at * len + 110)) continue;
      if ((def.rollers ?? []).some((r) => s > r.at * len - 20 && s < r.at * len + r.length + 30)) continue;
      const idx = this.wrap(Math.round(s / this.ds));
      const hw = this.hw[idx];
      if (hw < 8.5 || Math.abs(this.curv[idx]) > 0.012 || this.walled[idx]) continue;
      // Mostly big rocks and fallen logs; the wide ones only where there's room to get by.
      const pick = rnd();
      const roomy = hw >= 10;
      const kind: Obstacle['kind'] = pick < 0.45 ? 'rock' : pick < 0.65 && roomy ? 'log' : pick < 0.82 ? 'boulder' : 'barrier';
      const radius = kind === 'rock' ? (roomy ? 1.7 + rnd() * 0.8 : 1.4) : kind === 'log' ? 2.7 : kind === 'barrier' ? 1.3 : 1.1 + rnd() * 0.5;
      const lateral = (rnd() < 0.5 ? -1 : 1) * Math.min(hw * (0.2 + rnd() * 0.5), hw - radius - 0.5);
      taken.push(s);
      this.obstacles.push({
        idx,
        lateral,
        x: this.px[idx] + this.lx[idx] * lateral,
        z: this.pz[idx] + this.lz[idx] * lateral,
        radius,
        kind,
        angle: Math.PI / 2 + (rnd() - 0.5) * 0.7,
      });
    }  }

  wrap(i: number) {
    const n = this.n;
    if (this.closed) return ((i % n) + n) % n;
    return i < 0 ? 0 : i >= n ? n - 1 : i;
  }

  yawAt(i: number) {
    return Math.atan2(this.tx[i], this.tz[i]);
  }

  /** Index of the closest sample. Pass a hint to search only near it. */
  nearest(x: number, z: number, hint = -1, win = 14) {
    let best = Infinity;
    let bi = 0;
    if (hint < 0) {
      for (let i = 0; i < this.n; i++) {
        const dx = x - this.px[i];
        const dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < best) {
          best = d;
          bi = i;
        }
      }
      return bi;
    }
    for (let k = -win; k <= win; k++) {
      const i = this.wrap(hint + k);
      const dx = x - this.px[i];
      const dz = z - this.pz[i];
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    return bi;
  }

  pointAt(i: number, lateral: number, out: THREE.Vector3) {
    return out.set(this.px[i] + this.lx[i] * lateral, this.py[i], this.pz[i] + this.lz[i] * lateral);
  }
}

/**
 * Bends stretches of the centerline into a slalom: the points are pushed
 * side to side, then re-spaced evenly so everything downstream still gets
 * uniform samples.
 */
function weave(sp: THREE.Vector3[], closed: boolean, len: number, slaloms: NonNullable<TrackDef['slaloms']>) {
  const m = sp.length;
  const ds = len / (m - 1);
  const moved = sp.map((p, i) => {
    const a = sp[closed ? (i - 1 + (m - 1)) % (m - 1) : Math.max(0, i - 1)];
    const b = sp[closed ? (i + 1) % (m - 1) : Math.min(m - 1, i + 1)];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    let off = 0;
    for (const w of slaloms) {
      const u = (i * ds - w.at * len) / w.length;
      if (u <= 0 || u >= 1) continue;
      // Ease in and out so the weave joins the course without a kink.
      off += w.amp * Math.sin(u * w.waves * Math.PI * 2) * smoothstep(0, 0.2, u) * (1 - smoothstep(0.8, 1, u));
    }
    return new THREE.Vector3(p.x + (tz / l) * off, p.y, p.z - (tx / l) * off);
  });
  if (closed) moved[m - 1].copy(moved[0]);

  const cum = [0];
  for (let i = 1; i < m; i++) cum.push(cum[i - 1] + moved[i].distanceTo(moved[i - 1]));
  const total = cum[m - 1];
  const count = Math.round(total / SAMPLE_SPACING);
  const out: THREE.Vector3[] = [];
  let j = 0;
  for (let k = 0; k <= count; k++) {
    const s = (k / count) * total;
    while (j < m - 2 && cum[j + 1] < s) j++;
    const span = cum[j + 1] - cum[j] || 1;
    out.push(moved[j].clone().lerp(moved[j + 1], (s - cum[j]) / span));
  }
  return out;
}

/** Flat outline of a track, for menu thumbnails and the minimap. */
export function trackOutline(def: TrackDef, points = 240): [number, number][] {
  const pts = def.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const curve = new THREE.CatmullRomCurve3(pts, def.closed, 'centripetal');
  return curve.getPoints(points).map((p) => [p.x, p.z]);
}
