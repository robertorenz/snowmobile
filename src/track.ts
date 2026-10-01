import * as THREE from 'three';
import type { TrackDef, JumpDef, CrossingKind } from './tracks';
import { mulberry32, smoothstep, wrapAngle } from './util';

/** Distance between centerline samples, in metres (approximate). */
const SAMPLE_SPACING = 2;
const OPEN_START = 60;
const OPEN_RUNOFF = 100;

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

/** Something solid sitting on the racing surface. */
export interface Obstacle {
  /** Centerline sample it sits beside. */
  idx: number;
  /** Sideways offset from the centerline (positive is left). */
  lateral: number;
  x: number;
  z: number;
  radius: number;
  kind: 'barrier' | 'boulder';
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
    const len = curve.getLength();
    const seg = Math.round(len / SAMPLE_SPACING);
    const sp = curve.getSpacedPoints(seg);

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
      this.hw[i] = w / 2;
    }
    for (let i = 0; i < n; i++) {
      this.px[i] = sp[i].x;
      this.py[i] = sp[i].y;
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
          else if (u < 0.6) this.caution[i] = 37;
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
    while (this.obstacles.length < (def.obstacles ?? 0) && tries++ < 4000) {
      const s = from + rnd() * (to - from);
      if (taken.some((t) => Math.abs(t - s) < 70)) continue;
      // Keep run-ups and landing zones clear.
      if (this.ramps.some((j) => s > j.at * len - 130 && s < j.at * len + 110)) continue;
      if ((def.rollers ?? []).some((r) => s > r.at * len - 20 && s < r.at * len + r.length + 30)) continue;
      const idx = this.wrap(Math.round(s / this.ds));
      const hw = this.hw[idx];
      if (hw < 8.5 || Math.abs(this.curv[idx]) > 0.012) continue;
      const kind = rnd() < 0.55 ? 'barrier' : 'boulder';
      const lateral = (rnd() < 0.5 ? -1 : 1) * hw * (0.2 + rnd() * 0.5);
      taken.push(s);
      this.obstacles.push({
        idx,
        lateral,
        x: this.px[idx] + this.lx[idx] * lateral,
        z: this.pz[idx] + this.lz[idx] * lateral,
        radius: kind === 'barrier' ? 1.3 : 1.1 + rnd() * 0.5,
        kind,
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

/** Flat outline of a track, for menu thumbnails and the minimap. */
export function trackOutline(def: TrackDef, points = 240): [number, number][] {
  const pts = def.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const curve = new THREE.CatmullRomCurve3(pts, def.closed, 'centripetal');
  return curve.getPoints(points).map((p) => [p.x, p.z]);
}
