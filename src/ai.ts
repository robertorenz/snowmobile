import { Sled, SLED } from './sled';
import type { World } from './world';
import type { DifficultyDef } from './tracks';
import { clamp, wrapAngle } from './util';

/**
 * Drives a sled around the course: steers at a point ahead on its chosen
 * line, slows for the tightest corner coming up, and moves over for traffic.
 */
export class AIDriver {
  private lane: number;
  private baseLane: number;
  private phase = Math.random() * 100;
  private stuck = 0;
  private boostHold = false;
  /** After the flag: ease off (circuits) or stop (point-to-point). */
  coolDown = false;

  constructor(
    readonly sled: Sled,
    private cfg: DifficultyDef,
    private baseScale: number,
    lane: number,
  ) {
    this.lane = lane;
    this.baseLane = lane * 0.6;
    sled.speedScale = baseScale;
  }

  update(dt: number, world: World, sleds: Sled[], playerProgress: number | null, time: number) {
    const s = this.sled;
    const track = world.track;
    const cfg = this.cfg;
    const speed = s.speed;
    const inp = s.input;

    // Pace bends slightly toward the player so races stay close.
    if (playerProgress !== null && !this.coolDown) {
      const gap = playerProgress - s.progress;
      s.speedScale = this.baseScale * (1 + clamp(gap / 160, -1, 1) * cfg.rubber);
    }

    // Line: drift to the inside of the corner ahead.
    const lookN = Math.round((9 + speed * 0.5) / track.ds);
    const ti = track.wrap(s.idx + lookN);
    // Plan for the narrower of where we are and where we're heading.
    const hw = Math.min(track.hw[s.idx], track.hw[ti]);
    let want = this.baseLane + clamp(track.curv[ti] * 45, -1, 1) * hw * 0.5;

    // Traffic: move off the line of a sled just ahead.
    for (const o of sleds) {
      if (o === s) continue;
      const ahead = o.progress - s.progress;
      if (ahead > 0 && ahead < 16 && Math.abs(o.lateral - s.lateral) < 2.8) {
        want += s.lateral >= o.lateral ? 3.5 : -3.5;
      }
    }
    want = clamp(want, -(hw - 2.5), hw - 2.5);

    // Obstacles: if the line runs into one, pass on the side with more room.
    let dodging = false;
    let blocked = false;
    for (const o of track.obstacles) {
      let ahead = o.idx - s.idx;
      if (track.closed) {
        if (ahead < -track.n / 2) ahead += track.n;
        else if (ahead > track.n / 2) ahead -= track.n;
      }
      const dist = ahead * track.ds;
      if (dist < -3 || dist > 22 + speed * 1.4) continue;
      const clear = o.radius + 2.8;
      // Pass on the side we're already on, unless there's no room there.
      let side = s.lateral >= o.lateral ? 1 : -1;
      if (Math.abs(o.lateral + side * clear) > hw - 1.5) side = -side;
      if ((want - o.lateral) * side < clear) {
        want = o.lateral + side * clear;
        dodging = true;
      }
      // Still lined up with it and close: ease off until we're clear.
      if (dist < 30 && Math.abs(s.lateral - o.lateral) < o.radius + 1.8) blocked = true;
    }
    this.lane += (want - this.lane) * Math.min(1, (dodging ? 6 : 1.8) * dt);

    const tx = track.px[ti] + track.lx[ti] * this.lane;
    const tz = track.pz[ti] + track.lz[ti] * this.lane;
    const wobble = Math.sin(time * 1.7 + this.phase) * 0.07 * cfg.error;
    const diff = wrapAngle(Math.atan2(tx - s.pos.x, tz - s.pos.z) - s.yaw) + wobble;
    const steer = clamp(diff * 2.4, -1, 1);
    inp.steer += (steer - inp.steer) * Math.min(1, 12 * dt);

    // Speed: fast enough for the tightest corner within braking range.
    const scanN = Math.round((speed * 1.4 + 18) / track.ds);
    let kMax = 0;
    for (let k = 0; k <= scanN; k += 2) {
      const c = Math.abs(track.curv[track.wrap(s.idx + k)]);
      if (c > kMax) kMax = c;
    }
    let target = Math.sqrt((SLED.aLat * cfg.corner * 0.82) / Math.max(kMax, 1e-4));
    if (blocked) target = Math.min(target, Math.max(16, speed * 0.8));
    if (this.coolDown) target = track.closed ? Math.min(target, 16) : 0;

    if (speed < target) {
      inp.throttle = 1;
      inp.brake = 0;
    } else if (speed < target + 3) {
      inp.throttle = 0.25;
      inp.brake = 0;
    } else {
      inp.throttle = 0;
      inp.brake = clamp((speed - target) / 8, 0.25, 1);
    }

    // Boost on straights, in bursts.
    if (cfg.boost > 0 && !this.coolDown) {
      if (!this.boostHold && s.boost > 1 - cfg.boost * 0.5 && kMax < 0.004) this.boostHold = true;
      if (s.boost < 0.15 || kMax > 0.008) this.boostHold = false;
    } else this.boostHold = false;
    inp.boost = this.boostHold;

    // Recover if wedged against scenery or lost in the powder.
    if (!this.coolDown && speed < 2.5) this.stuck += dt;
    else this.stuck = 0;
    if (this.stuck > 2.5 || Math.abs(s.lateral) > hw + 30) {
      s.resetToTrack(world);
      this.stuck = 0;
    }
  }
}
