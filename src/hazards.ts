import * as THREE from 'three';
import type { World } from './world';
import type { Crossing } from './track';
import { mulberry32 } from './util';

/** Something moving on the course that a sled can run into. */
export interface Mover {
  kind: 'plough' | 'rock' | 'log';
  x: number;
  y: number;
  z: number;
  /** Radius for collisions. */
  r: number;
  /** Where it is on the course, for the AI to steer round: nearest sample, sideways offset, and how wide a berth to give it. */
  idx: number;
  lateral: number;
  radius: number;
  /** False while it is parked out of the way (a rock waiting up the hill). */
  active: boolean;
  /** Solid things (the plough) bounce a sled off; the rest knock it about as they go by. */
  solid: boolean;
  /** A sled this far above the ground clears it. */
  height: number;
  mesh: THREE.Object3D;
}

// ---------- Drawbridge timing ----------

/** One full cycle of a drawbridge, in seconds, and how its time is spent. */
const BRIDGE_PERIOD = 15;
const BRIDGE_DOWN = 9.2;
const BRIDGE_RISE = 1.4;
const BRIDGE_UP = 3.0;
/** How far the leaves lift, in radians. */
const BRIDGE_MAX = 1.0;
/** Up to this angle a leaf is a ramp you can ride; past it, it's a wall. */
export const BRIDGE_RIDEABLE = 0.3;
/** The warning lights come on this long before the bridge starts to lift. */
export const BRIDGE_WARNING = 2.2;

/** Seconds into its cycle that a drawbridge is at race time t. Each bridge runs to its own beat. */
export function bridgePhase(c: Crossing, t: number) {
  return (((t + c.idx * 0.37) % BRIDGE_PERIOD) + BRIDGE_PERIOD) % BRIDGE_PERIOD;
}

/** How far a drawbridge's leaves are lifted at race time t, in radians: 0 is flat. */
export function bridgeAngle(c: Crossing, t: number) {
  const p = bridgePhase(c, t);
  if (p < BRIDGE_DOWN) return 0;
  const ease = (u: number) => u * u * (3 - 2 * u);
  if (p < BRIDGE_DOWN + BRIDGE_RISE) return BRIDGE_MAX * ease((p - BRIDGE_DOWN) / BRIDGE_RISE);
  if (p < BRIDGE_DOWN + BRIDGE_RISE + BRIDGE_UP) return BRIDGE_MAX;
  return BRIDGE_MAX * (1 - ease((p - BRIDGE_DOWN - BRIDGE_RISE - BRIDGE_UP) / (BRIDGE_PERIOD - BRIDGE_DOWN - BRIDGE_RISE - BRIDGE_UP)));
}

/** True while a drawbridge is showing red: about to lift, lifting, up, or coming down. */
export function bridgeRed(c: Crossing, t: number) {
  return bridgePhase(c, t) > BRIDGE_DOWN - BRIDGE_WARNING;
}

// ---------- Ploughs, rockfalls and rolling logs ----------

const ROCK_CROSSING = 2.8;
const LOG_SPEED = 11;

/**
 * The moving hazards on a track. Everything is placed from the race clock
 * alone, so every computer in an online race sees the same thing.
 */
export class Hazards {
  readonly movers: Mover[] = [];
  private update: ((t: number) => void)[] = [];

  constructor(private world: World) {
    const { track, def } = world;
    const len = track.length;
    for (const [h, hz] of (def.hazards ?? []).entries()) {
      if (hz.kind === 'plough') this.addPlough(hz.lane, hz.speed ?? 8, hz.start ?? 0.4);
      else if (hz.kind === 'rockfall') this.addRockfall(hz.at * len, hz.length, hz.side, hz.every ?? 4.5, h);
      else this.addLogs(hz.from * len, hz.to * len, hz.count ?? 3, h);
    }
    this.setTime(0);
  }

  private place(m: Mover, s: number, lateral: number, lift: number) {
    const track = this.world.track;
    const i = track.wrap(Math.round(s / track.ds));
    m.idx = i;
    m.lateral = lateral;
    m.x = track.px[i] + track.lx[i] * lateral;
    m.z = track.pz[i] + track.lz[i] * lateral;
    m.y = this.world.ground(m.x, m.z, i);
    m.mesh.position.set(m.x, m.y + lift, m.z);
    return i;
  }

  /** A snowplough crawling round the course in one lane, beacon flashing. */
  private addPlough(lane: number, speed: number, start: number) {
    const { track, scene } = this.world;
    const g = new THREE.Group();
    const orange = new THREE.MeshStandardMaterial({ color: 0xe8862a, roughness: 0.55 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x20272e, roughness: 0.8 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xb8c2cb, roughness: 0.4, metalness: 0.6 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.2, 4.2), orange);
    body.position.y = 1.2;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.1, 1.7), orange);
    cab.position.set(0, 2.3, 0.6);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(2.14, 0.6, 1.3), new THREE.MeshStandardMaterial({ color: 0x1b2a38, roughness: 0.2, metalness: 0.4 }));
    glass.position.set(0, 2.42, 0.7);
    // The blade is angled, to throw the snow to one side.
    const blade = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.1, 0.25), steel);
    blade.position.set(0, 0.6, 2.5);
    blade.rotation.y = 0.3;
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.24, 10), new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xffa000, emissiveIntensity: 3 }));
    beacon.position.set(0, 2.98, 0.6);
    g.add(body, cab, glass, blade, beacon);
    for (const x of [-1.05, 1.05]) {
      const tread = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.75, 4.3), dark);
      tread.position.set(x, 0.38, 0);
      g.add(tread);
    }
    g.traverse((o) => (o.castShadow = true));
    scene.add(g);
    const m: Mover = { kind: 'plough', x: 0, y: 0, z: 0, r: 2.4, idx: 0, lateral: 0, radius: 2.6, active: true, solid: true, height: 3, mesh: g };
    this.movers.push(m);
    // A circuit is lapped; a descent is driven from just past the start to just short of the finish, over and over.
    const from = track.closed ? 0 : track.startS + 140;
    const run = track.closed ? track.length : Math.max(200, track.raceLength - 260);
    this.update.push((t) => {
      const s = from + ((start * run + speed * t) % run);
      const probe = track.wrap(Math.round(s / track.ds));
      const i = this.place(m, s, lane * track.hw[probe] * 0.5, 0);
      g.rotation.y = track.yawAt(i);
      (beacon.material as THREE.MeshStandardMaterial).emissiveIntensity = Math.sin(t * 9) > 0 ? 3.2 : 0.3;
    });
  }

  /** A stretch where boulders come bounding down across the road, one chute after another. */
  private addRockfall(at: number, length: number, side: 1 | -1, every: number, seed: number) {
    const { track, scene, terrain } = this.world;
    const rnd = mulberry32(seed * 131 + 7);
    const mat = new THREE.MeshStandardMaterial({ color: 0x6a6f76, roughness: 0.95, flatShading: true });
    const chutes = Math.max(2, Math.round(length / 28));
    for (let k = 0; k < chutes; k++) {
      const r = 1.05 + rnd() * 0.5;
      const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), mat);
      mesh.castShadow = true;
      scene.add(mesh);
      const m: Mover = { kind: 'rock', x: 0, y: 0, z: 0, r, idx: 0, lateral: 0, radius: r + 1, active: false, solid: false, height: r * 2, mesh };
      this.movers.push(m);
      const s = at + ((k + 0.5) / chutes) * length;
      const offset = rnd() * every;
      const i = track.wrap(Math.round(s / track.ds));
      const far = track.hw[i] + 17;
      this.update.push((t) => {
        const u = ((t + offset) % every) / ROCK_CROSSING;
        m.active = u < 1;
        // Waiting its turn, it sits up the slope where it can be seen.
        const lateral = m.active ? side * far * (1 - 1.8 * u) : side * far;
        m.idx = i;
        m.lateral = lateral;
        m.x = track.px[i] + track.lx[i] * lateral;
        m.z = track.pz[i] + track.lz[i] * lateral;
        m.y = terrain.height(m.x, m.z);
        mesh.position.set(m.x, m.y + r * 0.8 + (m.active ? Math.abs(Math.sin(u * Math.PI * 4)) * 1.1 : 0), m.z);
        mesh.rotation.set(u * 9, k, u * 7);
      });
    }
    // The AI takes the stretch steadily.
    for (let j = Math.floor((at - 30) / track.ds); j < (at + length) / track.ds; j++) {
      const w = track.wrap(j);
      track.caution[w] = Math.min(track.caution[w], 34);
    }
  }

  /** Logs rolling down a stretch of road toward the riders, each in a different lane every time. */
  private addLogs(from: number, to: number, count: number, seed: number) {
    const { track, scene } = this.world;
    const bark = new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 0.95 });
    const cut = new THREE.MeshStandardMaterial({ color: 0xc9a878, roughness: 0.9 });
    const distance = to - from;
    const period = distance / LOG_SPEED;
    for (let k = 0; k < count; k++) {
      const g = new THREE.Group();
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 4.2, 10).rotateZ(Math.PI / 2), [bark, cut, cut]);
      log.castShadow = true;
      g.add(log);
      scene.add(g);
      const m: Mover = { kind: 'log', x: 0, y: 0, z: 0, r: 1.5, idx: 0, lateral: 0, radius: 2.4, active: true, solid: false, height: 1.2, mesh: g };
      this.movers.push(m);
      this.update.push((t) => {
        const turn = t / period + k / count;
        const u = turn % 1;
        const lane = mulberry32(Math.floor(turn) * 97 + k * 13 + seed)() * 1.4 - 0.7;
        const s = to - u * distance;
        const probe = track.wrap(Math.round(s / track.ds));
        const i = this.place(m, s, lane * (track.hw[probe] - 2.4), 0.55);
        g.rotation.y = track.yawAt(i);
        log.rotation.x = -t * (LOG_SPEED / 0.55);
      });
    }
  }

  /** Moves everything to where it is at race time t. */
  setTime(t: number) {
    for (const fn of this.update) fn(t);
  }
}
