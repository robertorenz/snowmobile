import * as THREE from 'three';
import { buildSledModel, poseSledModel, SledModel } from './sledModel';
import type { World } from './world';
import { clamp, lerp, wrapAngle } from './util';
import { GATE_HEIGHT, ICE, SHALE, ROCK, GRASS } from './track';
import { DEFAULT_SLED, SledSpec } from './sleds';

/** A sled's state as sent between computers in an online race. */
export interface SledNet {
  /** Grid slot. */
  i: number;
  p: [number, number, number];
  v: [number, number, number];
  y: number;
  st: number;
  pr: number;
  la: number;
  b: number;
  g: number;
  /** Finish time, or 0 while still racing. */
  f: number;
  /** Flip angle, for showing tricks. */
  tr?: number;
  /** 1 once the rider has left the race. */
  x: number;
}

export interface SledInput {
  throttle: number;
  brake: number;
  /** -1..1, positive steers left. */
  steer: number;
  boost: boolean;
  /** Held in the air to flip. */
  trick?: boolean;
  /** Use the held item (throw a snowball). */
  item?: boolean;
}

const TAU = Math.PI * 2;
/** How fast a flip turns, in radians a second: one rotation takes three quarters of a second. */
const FLIP_RATE = TAU / 0.75;
const X_AXIS = new THREE.Vector3(1, 0, 0);
const _flip = new THREE.Quaternion();

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
  iceGrip: 0.45,
  /** On ice the track can't bite: this much of the normal drive and braking gets through. */
  iceTraction: 0.4,
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

  /** How far through a flip the sled is, in radians; 0 when not flipping. */
  trickAngle = 0;
  /** Outcome of the last landing, for the HUD to announce: flips landed, or -1 for a bail. Cleared once read. */
  trickResult = 0;
  /** 0..1: how well tucked in behind another sled this one is. */
  draft = 0;
  /** A shield soaks up the next hit. */
  shield = false;
  /** The item being carried, if any. */
  item: 'snowball' | null = null;

  /** 0 fresh to 1 wrecked. Knocks cost top speed until the sled is repaired. */
  damage = 0;
  /** True while the current knock has already been counted as damage. */
  hurt = false;
  /** The avalanche (by number) that last buried this sled, so each one only does it once. */
  buriedBy = 0;
  /** Knocked out of an elimination race, and in what order (later is better). */
  eliminated = false;
  elimOrder = 0;

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

  /** Driven by another computer; we only display it. */
  remote = false;
  /** Its rider left the race. */
  gone = false;
  private netPos = new THREE.Vector3();
  private netYaw = 0;
  private netAge = 10;
  private netSeen = false;

  private up = new THREE.Vector3(0, 1, 0);
  private lean = 0;

  /** Snapshot of this sled for the network. */
  toNet(slot: number): SledNet {
    const r = (v: number) => Math.round(v * 100) / 100;
    return {
      i: slot,
      p: [r(this.pos.x), r(this.pos.y), r(this.pos.z)],
      v: [r(this.vel.x), r(this.vel.y), r(this.vel.z)],
      y: Math.round(this.yaw * 1000) / 1000,
      st: r(this.input.steer),
      pr: r(this.progress),
      la: r(this.lateral),
      b: this.boosting ? 1 : 0,
      g: this.grounded ? 1 : 0,
      f: this.finished ? this.finishTime : 0,
      tr: Math.round(this.trickAngle * 10) / 10,
      x: this.gone ? 1 : 0,
    };
  }

  /** Takes a snapshot received for a remote sled. */
  applyNet(s: SledNet) {
    this.netPos.set(s.p[0], s.p[1], s.p[2]);
    this.vel.set(s.v[0], s.v[1], s.v[2]);
    this.netYaw = s.y;
    this.input.steer = s.st;
    this.progress = s.pr;
    this.lateral = s.la;
    this.boosting = !!s.b;
    this.grounded = !!s.g;
    if (s.f > 0 && !this.finished) {
      this.finished = true;
      this.finishTime = s.f;
    }
    this.trickAngle = s.tr ?? 0;
    if (s.x) this.gone = true;
    this.netAge = 0;
    if (!this.netSeen) {
      this.netSeen = true;
      this.pos.copy(this.netPos);
      this.yaw = this.netYaw;
    }
  }

  /** Moves a remote sled: coast along its last known velocity, easing onto each new snapshot. */
  updateRemote(dt: number, world: World) {
    this.netAge += dt;
    if (this.netSeen) {
      // Stop coasting if snapshots dry up, rather than sailing off the map.
      if (this.netAge < 0.5) this.netPos.addScaledVector(this.vel, dt);
      const k = 1 - Math.exp(-12 * dt);
      this.pos.lerp(this.netPos, k);
      this.yaw += wrapAngle(this.netYaw - this.yaw) * k;
      this.pos.y = Math.max(this.pos.y, world.ground(this.pos.x, this.pos.z, this.idx));
      this.idx = world.track.nearest(this.pos.x, this.pos.z, this.idx);
    }
    this.syncModel(dt);
  }

  /** Handling multipliers in force. AI riders borrow a model's looks but drive to the standard numbers, so difficulty stays as tuned. */
  private readonly drive: SledSpec;

  constructor(
    readonly name: string,
    readonly color: number,
    readonly isPlayer: boolean,
    readonly spec: SledSpec = DEFAULT_SLED,
    ownStats = isPlayer,
  ) {
    this.drive = ownStats ? spec : DEFAULT_SLED;
    this.model = buildSledModel(color, isPlayer ? 0xf3f8fc : 0x20303f, spec.shape);
  }

  get speed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** Puts the sled on the track at path distance s, offset sideways by lateral. */
  spawn(world: World, s: number, lateral: number) {
    const { track, terrain } = world;
    this.worldRef = world;
    if (!this.model.group.parent) world.scene.add(this.model.group);
    const steps = Math.round(s / track.ds);
    this.idx = track.wrap(steps);
    this.progressBase = steps * track.ds;
    this.progress = this.progressBase;
    this.lateral = lateral;
    const x = track.px[this.idx] + track.lx[this.idx] * lateral;
    const z = track.pz[this.idx] + track.lz[this.idx] * lateral;
    this.pos.set(x, world.ground(x, z, this.idx), z);
    this.vel.set(0, 0, 0);
    this.yaw = track.yawAt(this.idx);
    this.grounded = true;
    this.airTime = 0;
    world.groundNormal(x, z, this.idx, this.up);
    this.syncModel(0);
  }

  /** Hit by a snowball (or anything else thrown): a shield takes it, otherwise the sled is knocked back. */
  struck() {
    if (this.shield) {
      this.shield = false;
      return;
    }
    this.vel.x *= 0.55;
    this.vel.z *= 0.55;
    this.yaw += (Math.random() - 0.5) * 0.5;
    this.impact = Math.max(this.impact, 8);
  }

  /** Recovers a lost sled: back to the centerline where it left, stopped. */
  resetToTrack(world: World) {
    const { track, terrain } = world;
    // Around a crossing, go back far enough for a run at the ramp.
    const i = track.respawn[this.idx];
    if (i !== this.idx) {
      this.progressBase += (i - this.idx) * track.ds;
      this.progress = this.progressBase;
      this.idx = i;
    }
    this.pos.set(track.px[i], world.ground(track.px[i], track.pz[i], this.idx), track.pz[i]);
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
      pos.y = world.ground(pos.x, pos.z, this.idx);
      this.syncModel(dt);
      return;
    }

    // --- Steering ---
    let fx = Math.sin(this.yaw);
    let fz = Math.cos(this.yaw);
    let vf = vel.x * fx + vel.z * fz;
    const authority = this.grounded ? 1 : 0.3;
    const lowSpeed = Math.min(1, Math.abs(vf) / 5);
    const D = this.drive;
    const rate = Math.min(P.turnMax, P.aLat / Math.max(Math.abs(vf), 1)) * D.turn;
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
      // Lake ice is slippery but open: no deep snow to bog down in.
      const patch = track.surfaceAt(this.idx, this.lateral);
      const lakeIce = terrain.iceAt(pos.x, pos.z) > 0.5;
      const onIce = lakeIce || patch === ICE;
      this.offTrack = !lakeIce && Math.abs(this.lateral) > track.hw[this.idx] + 0.8;
      // Loose stone, bare rock and grass all hold a sled back; rock most of all.
      const rough = 1 - (1 - (patch === SHALE ? 0.74 : patch === ROCK ? 0.6 : patch === GRASS ? 0.86 : 1)) * D.rough;
      const cap = P.maxSpeed * D.speed * this.speedScale * (this.boosting ? P.boostSpeed : 1) * (this.offTrack ? D.offroad : rough) * (1 + 0.09 * this.draft) * (1 - 0.22 * this.damage);
      const bite = onIce ? P.iceTraction : 1;
      const acc = P.accel * D.accel * (this.boosting ? P.boostAccel : 1) * bite;

      if (inp.throttle > 0) vf += inp.throttle * acc * (1 - vf / cap) * dt;
      if (inp.brake > 0) {
        if (vf > 0.5) vf = Math.max(0, vf - inp.brake * P.brake * bite * dt);
        else vf = Math.max(-P.reverseSpeed, vf - inp.brake * P.accel * 0.6 * dt);
      }
      // Deep snow off the groomed surface drags hard.
      vf -= vf * (this.offTrack ? 0.9 : 0.1) * dt;
      if (rough < 1 && !this.offTrack) {
        vf -= vf * (1 - rough) * 2.4 * dt;
        // Stone rattles the sled.
        if (patch !== GRASS) this.rattle = Math.min(1, Math.abs(vf) / 25);
      }
      // Skis and track grind on a highway's tarmac.
      if (track.asphalt[this.idx]) vf -= vf * 2.6 * dt;
      if (inp.throttle <= 0 && inp.brake <= 0) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 2.5 * dt);

      // Gravity along the slope.
      const e = 1.2;
      const gx = (world.ground(pos.x + e, pos.z, this.idx) - world.ground(pos.x - e, pos.z, this.idx)) / (2 * e);
      const gz = (world.ground(pos.x, pos.z + e, this.idx) - world.ground(pos.x, pos.z - e, this.idx)) / (2 * e);
      const k = (-P.gravity * 1.1) / (1 + gx * gx + gz * gz);
      vf += (gx * fx + gz * fz) * k * dt;
      vl += (gx * lx + gz * lz) * k * dt;

      vl *= Math.exp(-(onIce ? P.iceGrip : this.offTrack ? 4 : P.grip) * D.grip * dt);
      vel.x = fx * vf + lx * vl;
      vel.z = fz * vf + lz * vl;
    } else {
      vel.x -= vel.x * 0.05 * dt;
      vel.z -= vel.z * 0.05 * dt;
    }

    // --- Move, then resolve against the snow ---
    const prevGround = world.ground(pos.x, pos.z, this.idx);
    pos.x += vel.x * dt;
    pos.z += vel.z * dt;
    const ground = world.ground(pos.x, pos.z, this.idx);
    const groundVy = (ground - prevGround) / dt;
    vel.y -= P.gravity * dt;
    pos.y += vel.y * dt;
    if (pos.y <= ground) {
      // Touching: take on the slope's vertical speed, so a ramp lip launches the sled.
      // Landing a flip: clean and it pays out boost, part-way round and it's a wreck.
      if (this.trickAngle > 0.4) {
        const turns = Math.round(this.trickAngle / TAU);
        if (turns >= 1 && Math.abs(this.trickAngle - turns * TAU) < 1.0) {
          this.boost = Math.min(1, this.boost + 0.45 * turns);
          this.trickResult = turns;
        } else {
          vel.x *= 0.45;
          vel.z *= 0.45;
          this.trickResult = -1;
          this.impact = Math.max(this.impact, 8);
        }
      }
      this.trickAngle = 0;
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

    // --- Flips: hold the trick key in the air; let go and the rotation carries on to the next full turn ---
    if (!this.grounded && this.airTime > 0.12) {
      const part = this.trickAngle % TAU;
      // A flip can only be started with real air underneath, not off a ripple.
      const room = gap > 0.9;
      if ((inp.trick && (room || part > 0.01)) || part > 0.01) {
        this.trickAngle += FLIP_RATE * dt;
        if (!inp.trick && this.trickAngle % TAU < part) this.trickAngle = Math.round(this.trickAngle / TAU) * TAU;
      }
    }

    // --- Into the river: fished out and put back on the track ---
    if (this.grounded && terrain.wetAt(pos.x, pos.z) > 0.7) {
      this.resetToTrack(world);
      this.impact = 9;
    }

    // --- Highway traffic: get hit and you're sent back ---
    for (const v of world.vehicles) {
      const dx = pos.x - v.x;
      const dz = pos.z - v.z;
      const along = dx * v.dx + dz * v.dz;
      const across = dz * v.dx - dx * v.dz;
      if (Math.abs(along) < v.halfLength + 1 && Math.abs(across) < 1.9 && pos.y < v.y + v.height) {
        this.resetToTrack(world);
        this.impact = 9;
        break;
      }
    }

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
        if (this.shield && -vn > 4) this.shield = false;
        else {
          vel.x *= 0.55;
          vel.z *= 0.55;
        }
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

    // --- Bridges and tunnels have solid sides ---
    if (track.walled[i]) {
      const limit = track.hw[i] - 0.7;
      if (Math.abs(this.lateral) > limit) {
        const over = this.lateral - Math.sign(this.lateral) * limit;
        pos.x -= track.lx[i] * over;
        pos.z -= track.lz[i] * over;
        this.lateral -= over;
        const vlat = vel.x * track.lx[i] + vel.z * track.lz[i];
        if (vlat * over > 0) {
          // Scrape along the wall: lose the sideways speed and a little of the rest.
          vel.x = (vel.x - track.lx[i] * vlat * 1.2) * 0.985;
          vel.z = (vel.z - track.lz[i] * vlat * 1.2) * 0.985;
          if (Math.abs(vlat) > 3) this.impact = Math.max(this.impact, Math.abs(vlat));
        }
      }
    }

    // --- Gates: clear the top rail or be sent back for another run ---
    for (const c of track.crossings) {
      if (c.kind !== 'gate' || old >= c.idx || this.idx < c.idx || this.idx - old > 30) continue;
      if (pos.y - world.ground(pos.x, pos.z, this.idx) < GATE_HEIGHT) {
        this.resetToTrack(world);
        this.impact = 9;
      }
    }

    this.syncModel(dt);
  }

  private syncModel(dt: number) {
    const g = this.model.group;
    const world = this.worldRef;
    if (world && this.grounded) world.groundNormal(this.pos.x, this.pos.z, this.idx, _n);
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
    if (this.trickAngle) g.quaternion.multiply(_flip.setFromAxisAngle(X_AXIS, -this.trickAngle));
    g.position.copy(this.pos);

    const speedK = clamp(this.speed / 25, 0, 1);
    const inp = this.input;
    this.lean = lerp(this.lean, -inp.steer * 0.55 * speedK, dt > 0 ? 1 - Math.exp(-8 * dt) : 1);

    if (dt > 0) {
      // Body on its springs: bumps and landings push it down, then it settles.
      const ay = clamp((this.vel.y - this.lastVy) / dt, -120, 120);
      if (this.rattle > 0) {
        this.heaveV += (Math.random() - 0.5) * 9 * this.rattle;
        this.rattle = 0;
      }
      this.lastVy = this.vel.y;
      const rest = this.grounded ? 0 : 0.07;
      this.heaveV += (-(this.heave - rest) * 220 - this.heaveV * 17 - (this.grounded ? ay * 0.55 : 0)) * dt;
      this.heave += this.heaveV * dt;
      if (this.heave < -0.17 || this.heave > 0.1) {
        this.heave = clamp(this.heave, -0.17, 0.1);
        this.heaveV = 0;
      }

      // Each ski rides the snow under it; in the air they hang at full droop.
      const fx = Math.sin(this.yaw);
      const fz = Math.cos(this.yaw);
      const follow = 1 - Math.exp(-30 * dt);
      for (let i = 0; i < 2; i++) {
        let target = -0.13;
        if (world && this.grounded) {
          const side = i === 0 ? 0.6 : -0.6;
          const dx = fz * side + fx * 0.85;
          const dz = -fx * side + fz * 0.85;
          const plane = this.pos.y - (this.up.x * dx + this.up.z * dz) / this.up.y;
          target = clamp(world.ground(this.pos.x + dx, this.pos.z + dz, this.idx) - plane, -0.16, 0.2);
        }
        this.skiTravel[i] += (target - this.skiTravel[i]) * follow;
      }

      // Squat under power, dive under braking.
      const pitch = (inp.brake * 0.05 - inp.throttle * 0.03) * (this.grounded ? 1 : 0);
      this.pitch += (pitch - this.pitch) * (1 - Math.exp(-6 * dt));
    }
    poseSledModel(this.model, this.heave, this.skiTravel[0], this.skiTravel[1], inp.steer, this.lean, this.pitch);
  }

  /** 0..1 while riding over stone: shakes the suspension. */
  private rattle = 0;
  private heave = 0;
  private heaveV = 0;
  private lastVy = 0;
  private pitch = 0;
  private skiTravel = [0, 0];

  private worldRef?: World;
}
