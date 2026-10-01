import * as THREE from 'three';
import { buildSledModel, SledModel } from './sledModel';
import type { World } from './world';
import { clamp, lerp } from './util';

export interface SledInput {
  throttle: number;
  brake: number;
  /** -1..1, positive steers left. */
  steer: number;
  boost: boolean;
}

/** Handling constants shared by every sled (SI units). */
export const SLED = {
  maxSpeed: 52,
  accel: 21,
  brake: 34,
  reverseSpeed: 7,
  /** Lateral acceleration available for cornering. */
  aLat: 32,
  turnMax: 1.8,
  grip: 6.5,
  radius: 1.15,
  boostSpeed: 1.26,
  boostAccel: 1.7,
  boostDrain: 0.33,
  boostRecharge: 0.07,
  gravity: 9.81 * 1.6,
};

const _n = new THREE.Vector3();
const _left = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class Sled {
  readonly model: SledModel;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  input: SledInput = { throttle: 0, brake: 0, steer: 0, boost: false };

  /** Top-speed multiplier; AI pace is set through this. */
  speedScale = 1;
  boost = 1;
  boosting = false;

  /** On (or within a hand's width of) the snow, so the sled has traction. */
  grounded = true;
  airTime = 0;
  offTrack = false;
  /** Strength of the most recent hit or landing; consumed by audio. */
  impact = 0;

  idx = 0;
  lateral = 0;
  /** Path distance travelled, in track metres. Start line is track.startS. */
  progress = 0;
  private progressBase = 0;
  finished = false;
  finishTime = 0;
  place = 0;

  private up = new THREE.Vector3(0, 1, 0);
  private lean = 0;

  constructor(
    readonly name: string,
    readonly color: number,
    readonly isPlayer: boolean,
  ) {
    this.model = buildSledModel(color, isPlayer ? 0xf3f8fc : 0x20303f);
  }

  get speed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** Puts the sled on the track at path distance s, offset sideways by lateral. */
  spawn(world: World, s: number, lateral: number) {
    const { track, terrain } = world;
    this.terrainRef = terrain;
    if (!this.model.group.parent) world.scene.add(this.model.group);
    const steps = Math.round(s / track.ds);
    this.idx = track.wrap(steps);
    this.progressBase = steps * track.ds;
    this.progress = this.progressBase;
    this.lateral = lateral;
    const x = track.px[this.idx] + track.lx[this.idx] * lateral;
    const z = track.pz[this.idx] + track.lz[this.idx] * lateral;
    this.pos.set(x, terrain.height(x, z), z);
    this.vel.set(0, 0, 0);
    this.yaw = track.yawAt(this.idx);
    this.grounded = true;
    this.airTime = 0;
    terrain.normal(x, z, this.up);
    this.syncModel(0);
  }

  /** Recovers a lost sled: back to the centerline where it left, stopped. */
  resetToTrack(world: World) {
    const { track, terrain } = world;
    const i = this.idx;
    this.pos.set(track.px[i], terrain.height(track.px[i], track.pz[i]), track.pz[i]);
    this.vel.set(0, 0, 0);
    this.yaw = track.yawAt(i);
    this.lateral = 0;
    this.grounded = true;
    this.airTime = 0;
  }

  update(dt: number, world: World, frozen: boolean) {
    const { terrain, track } = world;
    const P = SLED;
    const inp = this.input;
    const pos = this.pos;
    const vel = this.vel;

    if (frozen) {
      vel.set(0, 0, 0);
      pos.y = terrain.height(pos.x, pos.z);
      this.syncModel(dt);
      return;
    }

    // --- Steering ---
    let fx = Math.sin(this.yaw);
    let fz = Math.cos(this.yaw);
    let vf = vel.x * fx + vel.z * fz;
    const authority = this.grounded ? 1 : 0.3;
    const lowSpeed = Math.min(1, Math.abs(vf) / 5);
    const rate = Math.min(P.turnMax, P.aLat / Math.max(Math.abs(vf), 1));
    this.yaw += rate * inp.steer * lowSpeed * authority * (vf < -0.5 ? -1 : 1) * dt;

    fx = Math.sin(this.yaw);
    fz = Math.cos(this.yaw);
    const lx = fz;
    const lz = -fx;
    vf = vel.x * fx + vel.z * fz;
    let vl = vel.x * lx + vel.z * lz;

    // --- Boost meter ---
    this.boosting = inp.boost && inp.throttle > 0.1 && this.boost > 0.02;
    if (this.boosting) this.boost = Math.max(0, this.boost - P.boostDrain * dt);
    else this.boost = Math.min(1, this.boost + (this.grounded ? P.boostRecharge : P.boostRecharge * 5) * dt);

    if (this.grounded) {
      this.offTrack = Math.abs(this.lateral) > track.halfWidth + 0.8;
      const cap = P.maxSpeed * this.speedScale * (this.boosting ? P.boostSpeed : 1) * (this.offTrack ? 0.58 : 1);
      const acc = P.accel * (this.boosting ? P.boostAccel : 1);

      if (inp.throttle > 0) vf += inp.throttle * acc * (1 - vf / cap) * dt;
      if (inp.brake > 0) {
        if (vf > 0.5) vf = Math.max(0, vf - inp.brake * P.brake * dt);
        else vf = Math.max(-P.reverseSpeed, vf - inp.brake * P.accel * 0.6 * dt);
      }
      // Deep snow off the groomed surface drags hard.
      vf -= vf * (this.offTrack ? 0.9 : 0.1) * dt;
      if (inp.throttle <= 0 && inp.brake <= 0) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 2.5 * dt);

      // Gravity along the slope.
      const e = 1.2;
      const gx = (terrain.height(pos.x + e, pos.z) - terrain.height(pos.x - e, pos.z)) / (2 * e);
      const gz = (terrain.height(pos.x, pos.z + e) - terrain.height(pos.x, pos.z - e)) / (2 * e);
      const k = (-P.gravity * 0.55) / (1 + gx * gx + gz * gz);
      vf += (gx * fx + gz * fz) * k * dt;
      vl += (gx * lx + gz * lz) * k * dt;

      vl *= Math.exp(-(this.offTrack ? 4 : P.grip) * dt);
      vel.x = fx * vf + lx * vl;
      vel.z = fz * vf + lz * vl;
    } else {
      vel.x -= vel.x * 0.05 * dt;
      vel.z -= vel.z * 0.05 * dt;
    }

    // --- Move, then resolve against the snow ---
    const prevGround = terrain.height(pos.x, pos.z);
    pos.x += vel.x * dt;
    pos.z += vel.z * dt;
    const ground = terrain.height(pos.x, pos.z);
    const groundVy = (ground - prevGround) / dt;
    vel.y -= P.gravity * dt;
    pos.y += vel.y * dt;
    if (pos.y <= ground) {
      // Touching: take on the slope's vertical speed, so a ramp lip launches the sled.
      const hit = groundVy - vel.y;
      if (this.airTime > 0.25 && hit > 3) {
        this.impact = Math.max(this.impact, hit);
        const loss = clamp((hit - 6) * 0.012, 0, 0.25);
        vel.x *= 1 - loss;
        vel.z *= 1 - loss;
      }
      pos.y = ground;
      vel.y = groundVy;
    }
    const gap = pos.y - ground;
    this.grounded = gap < 0.25;
    this.airTime = this.grounded ? 0 : this.airTime + dt;

    // --- Trees and rocks ---
    world.colliders.near(pos.x, pos.z, (c) => {
      const dx = pos.x - c.x;
      const dz = pos.z - c.z;
      const min = c.r + P.radius * 0.8;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min || d2 < 1e-6 || gap > 3) return;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const nz = dz / d;
      pos.x += nx * (min - d);
      pos.z += nz * (min - d);
      const vn = vel.x * nx + vel.z * nz;
      if (vn < 0) {
        vel.x -= 1.3 * vn * nx;
        vel.z -= 1.3 * vn * nz;
        vel.x *= 0.55;
        vel.z *= 0.55;
        this.impact = Math.max(this.impact, -vn);
      }
    });

    // --- Where are we on the course? ---
    const old = this.idx;
    this.idx = track.nearest(pos.x, pos.z, old);
    let step = this.idx - old;
    if (track.closed) {
      if (step > track.n / 2) step -= track.n;
      else if (step < -track.n / 2) step += track.n;
    }
    this.progressBase += step * track.ds;
    const i = this.idx;
    const rx = pos.x - track.px[i];
    const rz = pos.z - track.pz[i];
    this.lateral = rx * track.lx[i] + rz * track.lz[i];
    this.progress = this.progressBase + clamp(rx * track.tx[i] + rz * track.tz[i], -track.ds, track.ds);

    this.syncModel(dt);
  }

  private syncModel(dt: number) {
    const g = this.model.group;
    const terrain = this.terrainRef;
    if (terrain && this.grounded) terrain.normal(this.pos.x, this.pos.z, _n);
    else {
      // In the air the nose follows the arc of the jump.
      const sp = Math.max(this.speed, 4);
      const pitch = clamp(this.vel.y / sp, -0.5, 0.5);
      _n.set(-Math.sin(this.yaw) * pitch, 1, -Math.cos(this.yaw) * pitch).normalize();
    }
    const blend = dt > 0 ? 1 - Math.exp(-(this.grounded ? 14 : 5) * dt) : 1;
    this.up.lerp(_n, blend).normalize();

    _left.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _fwd.crossVectors(_left, this.up).normalize();
    _left.crossVectors(this.up, _fwd).normalize();
    g.quaternion.setFromRotationMatrix(_m.makeBasis(_left, this.up, _fwd));
    g.position.copy(this.pos);

    const speedK = clamp(this.speed / 25, 0, 1);
    this.lean = lerp(this.lean, -this.input.steer * 0.3 * speedK, dt > 0 ? 1 - Math.exp(-8 * dt) : 1);
    this.model.body.rotation.z = this.lean;
    for (const ski of this.model.skis) ski.rotation.y = this.input.steer * 0.35;
  }

  private terrainRef?: World['terrain'];
}
