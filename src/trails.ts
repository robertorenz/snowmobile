import * as THREE from 'three';
import type { World } from './world';
import type { Sled } from './sled';
import { SNOW } from './track';
import { clamp } from './util';

/** Lanes across the road that pack down separately. */
const BINS = 8;
/** Stretches of trail kept; the oldest are overwritten once this many exist. */
const QUADS = 14000;
const WIDTH = 1.15;
/** A new stretch is laid every this many metres. */
const SEGMENT = 1.3;
/** How much one sled going by packs the snow under it (1 is fully packed). */
const PER_PASS = 0.3;

interface Tail {
  x: number;
  z: number;
  l: [number, number, number];
  r: [number, number, number];
  on: boolean;
  along: number;
}

/**
 * Snow that remembers. Every sled leaves a trail where it has been, and
 * the snow under it packs down: a few passes over the same line and it
 * rides faster than the loose snow either side. Both last for the race.
 */
export class SnowTrails {
  readonly mesh: THREE.Mesh | null = null;
  private pack: Float32Array;
  private pos: Float32Array | null = null;
  private uv: Float32Array | null = null;
  private written = 0;
  private dirtyFrom = -1;
  private dirtyTo = -1;
  private tails = new Map<Sled, Tail>();

  constructor(
    private world: World,
    /** Whether to draw the trails. The packed line is there either way. */
    visible: boolean,
  ) {
    this.pack = new Float32Array(world.track.n * BINS);
    if (!visible) return;
    this.pos = new Float32Array(QUADS * 12);
    this.uv = new Float32Array(QUADS * 8);
    const normal = new Float32Array(QUADS * 12);
    const index = new Uint32Array(QUADS * 6);
    for (let q = 0; q < QUADS; q++) {
      for (let k = 0; k < 4; k++) normal[q * 12 + k * 3 + 1] = 1;
      index.set([q * 4, q * 4 + 2, q * 4 + 1, q * 4 + 1, q * 4 + 2, q * 4 + 3], q * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshLambertMaterial({
        map: trailTexture(),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Fresh snow: a new race starts with no trails and nothing packed. */
  reset() {
    this.pack.fill(0);
    this.tails.clear();
    this.written = 0;
    this.dirtyFrom = this.dirtyTo = -1;
    this.mesh?.geometry.setDrawRange(0, 0);
  }

  private bin(idx: number, lateral: number) {
    const hw = this.world.track.hw[idx];
    return idx * BINS + clamp(Math.floor((lateral / hw) * 0.5 * BINS + BINS / 2), 0, BINS - 1);
  }

  /** 0 loose to 1 fully packed, at a point on the road. */
  packedAt(idx: number, lateral: number) {
    return this.pack[this.bin(idx, lateral)];
  }

  /** Call once a step for each sled: packs the snow under it and extends its trail. */
  record(s: Sled) {
    const { track, terrain, theme } = this.world;
    const i = s.idx;
    const onRoad = Math.abs(s.lateral) < track.hw[i];
    const snow =
      s.grounded &&
      !s.gone &&
      !track.asphalt[i] &&
      terrain.iceAt(s.pos.x, s.pos.z) < 0.5 &&
      (onRoad ? track.surfaceAt(i, s.lateral) === SNOW : !theme.meadow);
    let tail = this.tails.get(s);
    if (!tail) {
      tail = { x: s.pos.x, z: s.pos.z, l: [0, 0, 0], r: [0, 0, 0], on: false, along: 0 };
      this.tails.set(s, tail);
    }
    if (!snow) {
      tail.on = false;
      return;
    }
    const moved = Math.hypot(s.pos.x - tail.x, s.pos.z - tail.z);
    if (tail.on && moved < SEGMENT) return;

    // Edge points of the trail, square to the way the sled is facing.
    const sx = Math.cos(s.yaw) * WIDTH * 0.5;
    const sz = -Math.sin(s.yaw) * WIDTH * 0.5;
    const edge = (x: number, z: number): [number, number, number] => [x, this.world.ground(x, z, i) + 0.07, z];
    const l = edge(s.pos.x + sx, s.pos.z + sz);
    const r = edge(s.pos.x - sx, s.pos.z - sz);
    // A jump, a reset or a long gap starts a new trail rather than drawing a streak across it.
    if (tail.on && moved < 7) {
      if (onRoad) {
        const b = this.bin(i, s.lateral);
        this.pack[b] = Math.min(1, this.pack[b] + (PER_PASS * moved) / track.ds);
      }
      if (this.pos && this.uv) {
        const q = this.written % QUADS;
        this.pos.set([...tail.l, ...tail.r, ...l, ...r], q * 12);
        const v0 = tail.along * 0.7;
        const v1 = (tail.along + moved) * 0.7;
        this.uv.set([0, v0, 1, v0, 0, v1, 1, v1], q * 8);
        if (this.dirtyFrom < 0) this.dirtyFrom = q;
        // Wrapped round the buffer since the last upload: just send it all.
        if (q < this.dirtyFrom) this.dirtyFrom = 0;
        this.dirtyTo = Math.max(this.dirtyTo, q);
        if (q === 0 && this.written > 0) this.dirtyTo = QUADS - 1;
        this.written++;
      }
      tail.along += moved;
    }
    tail.x = s.pos.x;
    tail.z = s.pos.z;
    tail.l = l;
    tail.r = r;
    tail.on = true;
  }

  /** Sends this step's new stretches of trail to the graphics card. */
  flush() {
    if (!this.mesh || this.dirtyFrom < 0) return;
    const geo = this.mesh.geometry;
    const count = this.dirtyTo - this.dirtyFrom + 1;
    const p = geo.attributes.position as THREE.BufferAttribute;
    const u = geo.attributes.uv as THREE.BufferAttribute;
    p.clearUpdateRanges();
    p.addUpdateRange(this.dirtyFrom * 12, count * 12);
    p.needsUpdate = true;
    u.clearUpdateRanges();
    u.addUpdateRange(this.dirtyFrom * 8, count * 8);
    u.needsUpdate = true;
    geo.setDrawRange(0, Math.min(this.written, QUADS) * 6);
    this.dirtyFrom = this.dirtyTo = -1;
  }
}

/** Two ski lines and the lugged belt of the drive track between them, as shadow on snow. */
function trailTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(92, 116, 146, 0.5)';
  g.fillRect(5, 0, 7, 64);
  g.fillRect(52, 0, 7, 64);
  g.fillStyle = 'rgba(92, 116, 146, 0.3)';
  g.fillRect(21, 0, 22, 64);
  g.fillStyle = 'rgba(70, 92, 120, 0.42)';
  for (let y = 0; y < 64; y += 16) g.fillRect(21, y, 22, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
