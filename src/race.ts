import { Sled, SLED, SledInput } from './sled';
import { AIDriver } from './ai';
import type { World } from './world';
import { DIFFICULTIES, Difficulty } from './tracks';
import { clamp, lerp } from './util';

export type RacePhase = 'countdown' | 'racing' | 'finished';
export type RaceEvent = 'count' | 'go' | 'lap' | 'final-lap' | 'finish';

const RACERS = 6;
const AI_NAMES = ['Lindqvist', 'Tremblay', 'Yukimura', 'Kowalski', 'Halvorsen', 'Aspen'];
const PLAYER_COLOR = 0xf6a821;
const AI_COLORS = [0x1e88e5, 0xe5484d, 0x2fbf71, 0x13b5c2, 0xeef3f7, 0xff6f3c];
const COUNTDOWN = 3.6;

export interface Standing {
  sled: Sled;
  place: number;
  time: number;
  /** True when the time is a projection for a racer still on course. */
  estimated: boolean;
}

/** One race (or the menu's demo race): the grid, the clock and the rules. */
export class Race {
  readonly sleds: Sled[] = [];
  readonly player: Sled | null;
  phase: RacePhase = 'countdown';
  time = 0;
  countdown = COUNTDOWN;
  events: RaceEvent[] = [];
  playerLap = 1;
  wrongWay = 0;
  /** Seconds the player has been stranded; drives the reset hint. */
  stranded = 0;

  private ais: AIDriver[] = [];
  private autopilot: AIDriver | null = null;
  private lastCount = 4;
  private finishLine: number;

  constructor(
    readonly world: World,
    readonly difficulty: Difficulty,
    readonly attract: boolean,
  ) {
    const { track, def } = world;
    const cfg = DIFFICULTIES[difficulty];
    this.finishLine = track.startS + track.raceLength;
    const hw = track.halfWidth;

    for (let slot = 0; slot < RACERS; slot++) {
      // The player starts from the back of the grid.
      const isPlayer = !attract && slot === RACERS - 1;
      const sled = isPlayer
        ? new Sled('You', PLAYER_COLOR, true)
        : new Sled(AI_NAMES[slot], AI_COLORS[slot % AI_COLORS.length], false);
      const row = Math.floor(slot / 2);
      const side = slot % 2 ? -1 : 1;
      const lateral = side * hw * 0.38;
      sled.spawn(world, track.startS - 7 - row * 8 - (slot % 2) * 3, lateral);
      this.sleds.push(sled);
      if (!isPlayer) {
        // Spread the field: the pole sitter is the quickest.
        const t = attract ? slot / (RACERS - 1) : slot / (RACERS - 2);
        const pace = lerp(cfg.speed[1], cfg.speed[0], t) + def.aiBonus;
        this.ais.push(new AIDriver(sled, cfg, pace, lateral));
      }
    }
    this.player = attract ? null : this.sleds[RACERS - 1];
    if (attract) {
      this.phase = 'racing';
      this.countdown = 0;
    }
    this.rank();
  }

  step(dt: number, playerInput: SledInput | null) {
    const world = this.world;
    const track = world.track;

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown - 0.6);
      if (n < this.lastCount && n >= 1) {
        this.lastCount = n;
        this.events.push('count');
      }
      if (this.countdown <= 0.6) {
        this.phase = 'racing';
        this.events.push('go');
      }
    } else {
      this.time += dt;
      if (this.countdown > 0) this.countdown -= dt;
    }
    const frozen = this.phase === 'countdown';

    if (!frozen) {
      const pp = this.player && !this.player.finished ? this.player.progress : null;
      for (const ai of this.ais) ai.update(dt, world, this.sleds, pp, this.time);
      if (this.autopilot) this.autopilot.update(dt, world, this.sleds, null, this.time);
    }
    const p = this.player;
    if (p && !this.autopilot && playerInput) {
      p.input.throttle = playerInput.throttle;
      p.input.brake = playerInput.brake;
      p.input.steer = playerInput.steer;
      p.input.boost = playerInput.boost;
    }

    for (const s of this.sleds) {
      s.update(dt, world, frozen);
      if (!frozen) this.emitSpray(s);
    }
    this.collide();

    // Finish line
    for (const s of this.sleds) {
      if (s.finished || s.progress < this.finishLine) continue;
      s.finished = true;
      s.finishTime = this.time;
      if (s === p) {
        this.phase = 'finished';
        this.events.push('finish');
        this.autopilot = new AIDriver(s, DIFFICULTIES.medium, 0.85, s.lateral);
        this.autopilot.coolDown = true;
      } else {
        const ai = this.ais.find((a) => a.sled === s);
        // In the demo the field just keeps lapping.
        if (ai && !this.attract) ai.coolDown = true;
      }
    }

    if (p && !p.finished && !frozen) {
      if (track.closed) {
        const lap = clamp(Math.floor((p.progress - track.startS) / track.length) + 1, 1, track.def.laps);
        if (lap > this.playerLap) {
          this.playerLap = lap;
          this.events.push(lap === track.def.laps ? 'final-lap' : 'lap');
        }
      }
      const facing = Math.sin(p.yaw) * track.tx[p.idx] + Math.cos(p.yaw) * track.tz[p.idx];
      this.wrongWay = facing < -0.35 && p.speed > 4 ? this.wrongWay + dt : 0;
      const lost = Math.abs(p.lateral) > track.halfWidth + 22 || (p.speed < 1.5 && p.input.throttle > 0.5);
      this.stranded = lost ? this.stranded + dt : 0;
      if (Math.abs(p.lateral) > track.halfWidth + 70) p.resetToTrack(world);
    }

    this.rank();
  }

  private emitSpray(s: Sled) {
    const speed = s.speed;
    if (!s.grounded || speed < 6) return;
    const rate = (speed / SLED.maxSpeed) * (s.offTrack ? 2.2 : 1) * (s.boosting ? 1.6 : 1);
    if (Math.random() > rate * 0.75) return;
    const fx = Math.sin(s.yaw);
    const fz = Math.cos(s.yaw);
    const side = (Math.random() - 0.5) * 0.9;
    this.world.spray.emit(
      s.pos.x - fx * 1.4 + fz * side,
      s.pos.y + 0.2,
      s.pos.z - fz * 1.4 - fx * side,
      s.vel.x * 0.35 + (Math.random() - 0.5) * 3,
      1.5 + Math.random() * 3.5,
      s.vel.z * 0.35 + (Math.random() - 0.5) * 3,
    );
  }

  /** Sleds shove each other apart like bumper cars. */
  private collide() {
    const min = SLED.radius * 2;
    for (let i = 0; i < this.sleds.length; i++) {
      for (let j = i + 1; j < this.sleds.length; j++) {
        const a = this.sleds[i];
        const b = this.sleds[j];
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-6 || Math.abs(a.pos.y - b.pos.y) > 1.6) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const nz = dz / d;
        const push = (min - d) / 2;
        a.pos.x -= nx * push;
        a.pos.z -= nz * push;
        b.pos.x += nx * push;
        b.pos.z += nz * push;
        const rel = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
        if (rel < 0) {
          const jImp = rel * 0.75;
          a.vel.x += nx * jImp;
          a.vel.z += nz * jImp;
          b.vel.x -= nx * jImp;
          b.vel.z -= nz * jImp;
          a.impact = Math.max(a.impact, -rel);
          b.impact = Math.max(b.impact, -rel);
        }
      }
    }
  }

  private rank() {
    const order = [...this.sleds].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    order.forEach((s, i) => (s.place = i + 1));
  }

  /** Fraction of the race the player has covered, 0..1. */
  playerFraction() {
    if (!this.player) return 0;
    return clamp((this.player.progress - this.world.track.startS) / this.world.track.raceLength, 0, 1);
  }

  /** Final classification. Racers still on course get a projected time. */
  standings(): Standing[] {
    return [...this.sleds]
      .sort((a, b) => a.place - b.place)
      .map((sled) => {
        if (sled.finished) return { sled, place: sled.place, time: sled.finishTime, estimated: false };
        const remaining = Math.max(0, this.finishLine - sled.progress);
        const pace = Math.max(18, SLED.maxSpeed * sled.speedScale * 0.8);
        return { sled, place: sled.place, time: this.time + remaining / pace, estimated: true };
      });
  }

  dispose() {
    for (const s of this.sleds) {
      this.world.scene.remove(s.model.group);
      s.model.group.traverse((o) => {
        const mesh = o as import('three').Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material;
        if (mat) for (const one of Array.isArray(mat) ? mat : [mat]) one.dispose();
      });
    }
  }
}
