import * as THREE from 'three';
import type { TrackDef } from './tracks';
import { wrapAngle } from './util';

/** Distance between centerline samples, in metres (approximate). */
const SAMPLE_SPACING = 2;
const OPEN_START = 60;
const OPEN_RUNOFF = 100;

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
  readonly halfWidth: number;
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

    for (let i = 0; i < n; i++) {
      this.px[i] = sp[i].x;
      this.py[i] = sp[i].y;
      this.pz[i] = sp[i].z;
    }

    // Jump ramps: a rise that ends in a lip.
    for (const j of def.jumps) {
      const lip = j.at * len;
      for (let i = 0; i < n; i++) {
        const u = (i * this.ds - (lip - j.length)) / j.length;
        if (u > 0 && u <= 1) this.py[i] += j.height * u * u;
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
  }

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
