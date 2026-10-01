import * as THREE from 'three';
import { Sled, SLED, SledInput, SledNet } from './sled';
import { AIDriver } from './ai';
import type { World } from './world';
import type { GridEntry } from './net';
import { DIFFICULTIES, Difficulty } from './tracks';
import { clamp, lerp } from './util';

export type RacePhase = 'waiting' | 'countdown' | 'racing' | 'finished';
export type RaceEvent = 'count' | 'go' | 'lap' | 'final-lap' | 'finish';

export const RACERS = 6;
export const AI_NAMES = ['Lindqvist', 'Tremblay', 'Yukimura', 'Kowalski', 'Halvorsen', 'Aspen'];
/** Rider colours. Humans take them in order from the front; AI from the back. */
export const RIDER_COLORS = [0xf6a821, 0x1e88e5, 0xe5484d, 0x2fbf71, 0x13b5c2, 0xeef3f7];
const COUNTDOWN = 3.6;

export interface Standing {
  sled: Sled;
  place: number;
  time: number;
  /** True when the time is a projection for a racer still on course. */
  estimated: boolean;
}

/** Who is on the grid of an online race, and which of them this computer drives. */
export interface NetRace {
  grid: GridEntry[];
  localId: string;
  isHost: boolean;
}

/** The grid for a solo race: five AI riders, then the player at the back. */
export function soloGrid(attract: boolean): GridEntry[] {
  const grid: GridEntry[] = [];
  for (let slot = 0; slot < RACERS; slot++) {
    const human = !attract && slot === RACERS - 1;
    grid.push(
      human
        ? { kind: 'human', id: 'me', name: 'You', color: RIDER_COLORS[0] }
        : { kind: 'ai', id: '', name: AI_NAMES[slot], color: RIDER_COLORS[RIDER_COLORS.length - 1 - (slot % 5)] },
    );
  }
  return grid;
}

/** One race (or the menu's demo race): the grid, the clock and the rules. */
export class Race {
  readonly sleds: Sled[] = [];
  readonly player: Sled | null;
  readonly online: boolean;
  phase: RacePhase = 'waiting';
  time = 0;
  countdown = COUNTDOWN;
  events: RaceEvent[] = [];
  playerLap = 1;
  wrongWay = 0;
  /** Seconds the player has been stranded; drives the reset hint. */
  stranded = 0;

  private ais: AIDriver[] = [];
  private humans: Sled[] = [];
  private autopilot: AIDriver | null = null;
  private lastCount = 4;
  private finishLine: number;
  private grid: GridEntry[];

  constructor(
    readonly world: World,
    readonly difficulty: Difficulty,
    readonly attract: boolean,
    net: NetRace | null = null,
  ) {
    const { track, def } = world;
    const cfg = DIFFICULTIES[difficulty];
    this.finishLine = track.startS + track.raceLength;
    this.online = !!net;
    const grid = (this.grid = net ? net.grid : soloGrid(attract));
    const localId = net ? net.localId : 'me';
    const simulateAI = !net || net.isHost;
    const aiTotal = grid.filter((g) => g.kind === 'ai').length;
    let aiSeen = 0;
    let local: Sled | null = null;

    grid.forEach((entry, slot) => {
      const isPlayer = entry.kind === 'human' && entry.id === localId;
      const sled = new Sled(entry.name, entry.color, isPlayer);
      sled.remote = entry.kind === 'human' ? !isPlayer : !simulateAI;
      const row = Math.floor(slot / 2);
      const side = slot % 2 ? -1 : 1;
      const lateral = side * track.halfWidth * 0.38;
      sled.spawn(world, track.startS - 7 - row * 8 - (slot % 2) * 3, lateral);
      this.sleds.push(sled);
      if (isPlayer) local = sled;
      if (entry.kind === 'human') {
        this.humans.push(sled);
        if (!isPlayer) sled.model.group.add(nameTag(entry.name));
      } else {
        if (simulateAI) {
          // Spread the field: the pole sitter is the quickest.
          const t = aiTotal > 1 ? aiSeen / (aiTotal - 1) : 0.5;
          const pace = lerp(cfg.speed[1], cfg.speed[0], t) + def.aiBonus;
          this.ais.push(new AIDriver(sled, cfg, pace, lateral));
        }
        aiSeen++;
      }
    });
    this.player = local;
    // Solo races count down straight away; online ones wait for everyone to load.
    if (attract) {
      this.phase = 'racing';
      this.countdown = 0;
    } else if (!net) this.begin();
    this.rank();
  }

  /** Starts the countdown. */
  begin() {
    if (this.phase === 'waiting') this.phase = 'countdown';
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
    } else if (this.phase !== 'waiting') {
      this.time += dt;
      if (this.countdown > 0) this.countdown -= dt;
    }
    const frozen = this.phase === 'countdown' || this.phase === 'waiting';

    if (!frozen) {
      // AI pace leans toward the humans still racing.
      let pp: number | null = null;
      const racing = this.humans.filter((h) => !h.finished && !h.gone);
      if (racing.length) pp = racing.reduce((sum, h) => sum + h.progress, 0) / racing.length;
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
      if (s.gone) continue;
      if (s.remote) s.updateRemote(dt, world);
      else s.update(dt, world, frozen);
      if (!frozen) this.emitSpray(s);
    }
    this.collide();

    // Finish line. Remote sleds report their own finish.
    for (const s of this.sleds) {
      if (s.remote || s.finished || s.progress < this.finishLine) continue;
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

  /**
   * Sleds shove each other apart like bumper cars. A remote sled can't be
   * moved from here, so the local one takes the whole push.
   */
  private collide() {
    const min = SLED.radius * 2;
    for (let i = 0; i < this.sleds.length; i++) {
      for (let j = i + 1; j < this.sleds.length; j++) {
        const a = this.sleds[i];
        const b = this.sleds[j];
        if (a.gone || b.gone || (a.remote && b.remote)) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-6 || Math.abs(a.pos.y - b.pos.y) > 1.6) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const nz = dz / d;
        const overlap = min - d;
        const shareA = a.remote ? 0 : b.remote ? 1 : 0.5;
        const shareB = 1 - shareA;
        a.pos.x -= nx * overlap * shareA;
        a.pos.z -= nz * overlap * shareA;
        b.pos.x += nx * overlap * shareB;
        b.pos.z += nz * overlap * shareB;
        const rel = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
        if (rel < 0) {
          const jImp = rel * 0.75;
          if (!a.remote) {
            a.vel.x += nx * jImp;
            a.vel.z += nz * jImp;
            a.impact = Math.max(a.impact, -rel);
          }
          if (!b.remote) {
            b.vel.x -= nx * jImp;
            b.vel.z -= nz * jImp;
            b.impact = Math.max(b.impact, -rel);
          }
        }
      }
    }
  }

  private rank() {
    const order = [...this.sleds].sort((a, b) => {
      if (a.gone !== b.gone) return a.gone ? 1 : -1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    order.forEach((s, i) => (s.place = i + 1));
  }

  /** Number of riders still in the race. */
  get fieldSize() {
    return this.sleds.filter((s) => !s.gone).length;
  }

  /** Fraction of the race the player has covered, 0..1. */
  playerFraction() {
    if (!this.player) return 0;
    return clamp((this.player.progress - this.world.track.startS) / this.world.track.raceLength, 0, 1);
  }

  /** Final classification. Racers still on course get a projected time. */
  standings(): Standing[] {
    return this.sleds
      .filter((s) => !s.gone)
      .sort((a, b) => a.place - b.place)
      .map((sled) => {
        if (sled.finished) return { sled, place: sled.place, time: sled.finishTime, estimated: false };
        const remaining = Math.max(0, this.finishLine - sled.progress);
        const pace = Math.max(18, SLED.maxSpeed * sled.speedScale * 0.8);
        return { sled, place: sled.place, time: this.time + remaining / pace, estimated: true };
      });
  }

  /** True once every human rider has finished or left. */
  get humansDone() {
    return this.humans.every((h) => h.finished || h.gone);
  }

  // ---------- Online ----------

  /** Snapshots to send: just the sleds this computer drives, or (for the host) every sled. */
  netStates(all: boolean): SledNet[] {
    const out: SledNet[] = [];
    this.sleds.forEach((s, slot) => {
      if (!s.remote || all) out.push(s.toNet(slot));
    });
    return out;
  }

  /** Applies received snapshots. Only sleds driven elsewhere are touched; `from` limits which rider may speak for a slot. */
  applyNet(list: SledNet[], from: string | null) {
    for (const s of list) {
      const sled = this.sleds[s.i];
      const entry = this.grid[s.i];
      if (!sled || !entry || !sled.remote) continue;
      if (from !== null && (entry.kind !== 'human' || entry.id !== from)) continue;
      sled.applyNet(s);
      if (sled.gone) sled.model.group.visible = false;
    }
  }

  /** A rider dropped out: take their sled off the course. */
  markGone(id: string) {
    this.grid.forEach((entry, slot) => {
      if (entry.kind !== 'human' || entry.id !== id) return;
      this.sleds[slot].gone = true;
      this.sleds[slot].model.group.visible = false;
    });
  }

  dispose() {
    for (const s of this.sleds) {
      this.world.scene.remove(s.model.group);
      s.model.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) return;
        for (const one of Array.isArray(mat) ? mat : [mat]) {
          (one as THREE.SpriteMaterial).map?.dispose();
          one.dispose();
        }
      });
    }
  }
}

/** Floating name above another player's sled. */
function nameTag(name: string) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.font = '700 64px "Segoe UI", Arial, sans-serif';
  const w = Math.min(500, g.measureText(name).width + 56);
  g.fillStyle = 'rgba(10, 24, 38, 0.78)';
  g.beginPath();
  g.roundRect((512 - w) / 2, 14, w, 100, 28);
  g.fill();
  g.fillStyle = '#f3f8fc';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(name, 256, 68, 460);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(3.2, 0.8, 1);
  sprite.position.y = 2.7;
  return sprite;
}
