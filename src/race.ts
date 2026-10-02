import * as THREE from 'three';
import { Sled, SLED, SledInput, SledNet } from './sled';
import { AIDriver } from './ai';
import type { World } from './world';
import type { GridEntry } from './net';
import { DIFFICULTIES, Difficulty } from './tracks';
import { clamp, lerp } from './util';
import { SLEDS, DEFAULT_SLED, sledById, SledSpec } from './sleds';
import { buildSledModel } from './sledModel';

export type RacePhase = 'waiting' | 'countdown' | 'racing' | 'finished';
export type RaceEvent =
  | 'count'
  | 'go'
  | 'lap'
  | 'final-lap'
  | 'finish'
  | 'pickup'
  | 'throw'
  | 'struck'
  | 'knockout'
  | 'eliminated'
  | 'avalanche'
  | 'buried';

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
  /** Knocked out of an elimination race. */
  out?: boolean;
}

/** race: first to the finish. trial: alone against the clock and your ghost. elimination: last place is knocked out at intervals. */
export type RaceMode = 'race' | 'trial' | 'elimination';

export interface RaceOptions {
  mode?: RaceMode;
  /** A recorded run to race against in a time trial: x, y, z, yaw every GHOST_STEP seconds. */
  ghost?: number[] | null;
  /** Colour of the player's sled in a solo race. */
  paint?: number;
  /** The player's model with upgrades and stripe applied, for a solo race. */
  tuned?: SledSpec;
}

/** Seconds between samples of a recorded run. */
export const GHOST_STEP = 0.1;

/** Who is on the grid of an online race, and which of them this computer drives. */
export interface NetRace {
  grid: GridEntry[];
  localId: string;
  isHost: boolean;
}

/** The grid for a solo race: five AI riders, then the player at the back. */
export function soloGrid(attract: boolean, sled = DEFAULT_SLED.id): GridEntry[] {
  const grid: GridEntry[] = [];
  for (let slot = 0; slot < RACERS; slot++) {
    const human = !attract && slot === RACERS - 1;
    grid.push(
      human
        ? { kind: 'human', id: 'me', name: 'You', color: RIDER_COLORS[0], sled }
        : { kind: 'ai', id: '', name: AI_NAMES[slot], color: RIDER_COLORS[RIDER_COLORS.length - 1 - (slot % 5)], sled: aiSled(slot) },
    );
  }
  return grid;
}

/** AI riders turn up on a mix of models. */
export const aiSled = (slot: number) => SLEDS[(slot * 2 + 1) % SLEDS.length].id;

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

  /** Grid slots of sleds driven elsewhere that our snowballs have hit; main sends these on. */
  pendingHits: number[] = [];
  private snowballs: { s: number; lateral: number; speed: number; owner: Sled; life: number; mesh: THREE.Mesh }[] = [];
  /** The avalanche, once it has broken loose: how far down the course its front is, and how far it will run. */
  avalanche: { front: number; end: number; id: number; mesh: THREE.Group } | null = null;
  private avalanches = 0;
  readonly mode: RaceMode;
  /** The player's run so far, sampled for saving as a ghost. */
  readonly recording: number[] = [];
  private recordAt = 0;
  private ghost: THREE.Group | null = null;
  private ghostData: number[] | null = null;
  /** Elimination: seconds between knockouts, and until the next one. */
  knockoutEvery = 0;
  knockoutIn = 0;
  private knockouts = 0;
  private ais: AIDriver[] = [];
  private humans: Sled[] = [];
  private autopilot: AIDriver | null = null;
  private lastCount = 4;
  /** Path distance at which the race ends. */
  readonly finishLine: number;
  private grid: GridEntry[];

  constructor(
    readonly world: World,
    readonly difficulty: Difficulty,
    readonly attract: boolean,
    net: NetRace | null = null,
    sled = DEFAULT_SLED.id,
    opts: RaceOptions = {},
  ) {
    this.mode = opts.mode ?? 'race';
    world.trails.reset();
    const { track, def } = world;
    const cfg = DIFFICULTIES[difficulty];
    this.finishLine = track.startS + track.raceLength;
    this.online = !!net;
    // A time trial has no one else on the course.
    const solo = soloGrid(attract, sled);
    if (opts.paint !== undefined) for (const g of solo) if (g.kind === 'human') g.color = opts.paint;
    const grid = (this.grid = net ? net.grid : this.mode === 'trial' ? solo.filter((g) => g.kind === 'human') : solo);
    this.knockoutEvery = Math.max(14, (def.par ?? 120) / RACERS);
    this.knockoutIn = this.knockoutEvery;
    if (this.mode === 'trial' && opts.ghost && opts.ghost.length >= 8) {
      this.ghostData = opts.ghost;
      this.ghost = buildSledModel(0xbfd9ee, 0xffffff, sledById(sled).shape).group;
      // A ghost is see-through and casts no shadow.
      this.ghost.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.castShadow = false;
        const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
        if (mat) {
          mat.transparent = true;
          mat.opacity = 0.32;
          mat.depthWrite = false;
        }
      });
      world.scene.add(this.ghost);
    }
    const localId = net ? net.localId : 'me';
    const simulateAI = !net || net.isHost;
    const aiTotal = grid.filter((g) => g.kind === 'ai').length;
    let aiSeen = 0;
    let local: Sled | null = null;

    grid.forEach((entry, slot) => {
      const isPlayer = entry.kind === 'human' && entry.id === localId;
      const sled = new Sled(entry.name, entry.color, isPlayer, isPlayer && opts.tuned ? opts.tuned : sledById(entry.sled), isPlayer);
      sled.remote = entry.kind === 'human' ? !isPlayer : !simulateAI;
      const row = Math.floor(slot / 2);
      const side = slot % 2 ? -1 : 1;
      const lateral = side * track.hw[track.startIdx] * 0.38;
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
    // Traffic runs off the race clock, so every computer in an online race sees the same cars.
    world.setRaceTime(this.time);

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
      p.input.trick = playerInput.trick;
      p.input.item = playerInput.item;
    }

    for (const s of this.sleds) {
      if (s.gone) continue;
      if (s.remote) s.updateRemote(dt, world);
      else s.update(dt, world, frozen);
      if (!frozen) {
        this.emitSpray(s);
        world.trails.record(s);
      }
    }
    world.trails.flush();
    this.collide();
    if (!frozen) this.extras(dt);
    if (!frozen) this.modeRules(dt);

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
      const lost = Math.abs(p.lateral) > track.hw[p.idx] + 22 || (p.speed < 1.5 && p.input.throttle > 0.5);
      this.stranded = lost ? this.stranded + dt : 0;
      if (Math.abs(p.lateral) > track.hw[p.idx] + 70) p.resetToTrack(world);
    }

    this.rank();
  }

  /** Every sled's position and heading, sampled every GHOST_STEP seconds, for the replay. */
  readonly replay: number[][] = [];
  private replayAt = 0;
  private replayHint: number[] = [];

  /** Length of the recorded race, in seconds. */
  get replayLength() {
    return ((this.replay[0]?.length ?? 0) / 4) * GHOST_STEP;
  }

  /** Puts every sled where it was at time t of the recording. */
  showReplay(t: number, dt: number) {
    const track = this.world.track;
    this.sleds.forEach((s, k) => {
      const d = this.replay[k];
      if (!d || d.length < 8) return;
      const f = Math.min(t / GHOST_STEP, d.length / 4 - 1.001);
      const i = Math.floor(f);
      const u = f - i;
      const a = i * 4;
      s.pos.set(d[a] + (d[a + 4] - d[a]) * u, d[a + 1] + (d[a + 5] - d[a + 1]) * u, d[a + 2] + (d[a + 6] - d[a + 2]) * u);
      s.vel.set((d[a + 4] - d[a]) / GHOST_STEP, 0, (d[a + 6] - d[a + 2]) / GHOST_STEP);
      s.yaw = d[a + 3];
      // Keep track of which stretch of course it's on, so bridges are handled.
      this.replayHint[k] = s.idx = track.nearest(s.pos.x, s.pos.z, this.replayHint[k] ?? -1, 40);
      s.model.group.visible = true;
      s.present(dt);
    });
  }

  /** Time-trial ghost and recording; elimination knockouts. */
  private modeRules(dt: number) {
    const p = this.player;
    // Record everyone for the replay (up to eight minutes).
    if (p && !this.attract && this.time >= this.replayAt && this.time < 480) {
      this.replayAt += GHOST_STEP;
      const r = (v: number) => Math.round(v * 10) / 10;
      this.sleds.forEach((s, k) => (this.replay[k] ??= []).push(r(s.pos.x), r(s.pos.y), r(s.pos.z), Math.round(s.yaw * 100) / 100));
    }
    if (this.mode === 'trial' && p) {
      if (!p.finished && this.time >= this.recordAt) {
        this.recordAt += GHOST_STEP;
        const r = (v: number) => Math.round(v * 10) / 10;
        this.recording.push(r(p.pos.x), r(p.pos.y), r(p.pos.z), Math.round(p.yaw * 100) / 100);
      }
      const g = this.ghost;
      const d = this.ghostData;
      if (g && d) {
        const f = this.time / GHOST_STEP;
        const k = Math.floor(f);
        const u = f - k;
        const a = k * 4;
        g.visible = a + 7 < d.length;
        if (g.visible) {
          g.position.set(d[a] + (d[a + 4] - d[a]) * u, d[a + 1] + (d[a + 5] - d[a + 1]) * u, d[a + 2] + (d[a + 6] - d[a + 2]) * u);
          g.rotation.y = d[a + 3];
        }
      }
    }

    if (this.mode === 'elimination' && this.phase === 'racing') {
      this.knockoutIn -= dt;
      if (this.knockoutIn > 0) return;
      this.knockoutIn = this.knockoutEvery;
      const alive = this.sleds.filter((s) => !s.gone && !s.finished);
      if (alive.length < 2) return;
      const last = alive.reduce((a, b) => (a.place > b.place ? a : b));
      last.eliminated = true;
      last.elimOrder = ++this.knockouts;
      last.gone = true;
      last.model.group.visible = false;
      this.rank();
      if (last === p) {
        this.phase = 'finished';
        this.events.push('eliminated');
      } else {
        this.events.push('knockout');
        // Last one standing wins outright.
        if (alive.length === 2 && p && !p.gone) {
          p.finished = true;
          p.finishTime = this.time;
          this.phase = 'finished';
          this.events.push('finish');
        }
      }
    }
  }

  /** Slipstream, pickups and snowballs. */
  private extras(dt: number) {
    const { world } = this;
    const track = world.track;
    const p = this.player;

    // Damage: each hard knock takes a little off the sled's top speed until it's repaired.
    for (const s of this.sleds) {
      if (s.remote || s.gone) continue;
      // Only a real smash counts: ordinary landings and snowball hits don't.
      if (s.impact > 10) {
        if (!s.hurt) s.damage = Math.min(1, s.damage + 0.04 + (s.impact - 10) * 0.01);
        s.hurt = true;
      } else s.hurt = false;
    }

    // Deer: run into one and you're knocked back; it bolts.
    for (const a of world.animals) {
      if (!a.onRoad || a.cool > 0) continue;
      for (const s of this.sleds) {
        if (s.remote || s.gone || Math.hypot(s.pos.x - a.x, s.pos.z - a.z) > 1.7) continue;
        s.struck();
        a.scare();
        a.cool = 4;
        if (s === p) this.events.push('struck');
      }
    }

    // Avalanche: breaks loose behind the leading rider and runs down the course faster than most can ride.
    const av = track.def.avalanche;
    if (av && !this.avalanche && this.avalanches === 0) {
      const lead = Math.max(...this.humans.filter((h) => !h.gone).map((h) => h.progress), -Infinity);
      if (lead > av.at * track.length) {
        const mesh = new THREE.Group();
        const snow = new THREE.MeshStandardMaterial({ color: 0xf4f8fc, roughness: 1, flatShading: true });
        for (let k = 0; k < 16; k++) {
          const lump = new THREE.Mesh(new THREE.IcosahedronGeometry(1.6 + Math.random() * 2.2, 1), snow);
          lump.userData.lat = (Math.random() * 2 - 1) * 14;
          lump.userData.back = Math.random() * 16;
          mesh.add(lump);
        }
        world.scene.add(mesh);
        this.avalanche = { front: av.at * track.length - 150, end: av.at * track.length + av.length, id: ++this.avalanches, mesh };
        this.events.push('avalanche');
      }
    }
    const slide = this.avalanche;
    if (slide) {
      slide.front += 40 * dt;
      for (const lump of slide.mesh.children) {
        const i = track.wrap(Math.round((slide.front - lump.userData.back) / track.ds));
        const x = track.px[i] + track.lx[i] * lump.userData.lat;
        const z = track.pz[i] + track.lz[i] * lump.userData.lat;
        lump.position.set(x, world.ground(x, z, i) + 1.2 + Math.sin(this.time * 9 + lump.userData.lat) * 0.6, z);
        lump.rotation.x += dt * 6;
        if (Math.random() < 0.5) world.spray.emit(x, lump.position.y + 1, z, (Math.random() - 0.5) * 8, 3 + Math.random() * 6, (Math.random() - 0.5) * 8);
      }
      for (const s of this.sleds) {
        if (s.remote || s.gone || s.finished || s.buriedBy === slide.id) continue;
        if (s.progress < slide.front - 3 && s.progress > slide.front - 45) {
          // Buried: dug out at a standstill once it has gone by.
          s.buriedBy = slide.id;
          s.vel.set(0, 0, 0);
          s.impact = Math.max(s.impact, 10);
          if (s === p) this.events.push('buried');
        }
      }
      if (slide.front > slide.end) {
        world.scene.remove(slide.mesh);
        this.avalanche = null;
      }
    }

    // Slipstream: tucked in close behind another sled, the air is easier.
    for (const s of this.sleds) {
      if (s.remote || s.gone) continue;
      let towed = false;
      for (const o of this.sleds) {
        if (o === s || o.gone) continue;
        const ahead = o.progress - s.progress;
        if (ahead > 3 && ahead < 24 && Math.abs(o.lateral - s.lateral) < 2.4 && s.speed > 18) towed = true;
      }
      s.draft = clamp(s.draft + (towed ? 1.2 : -1.5) * dt, 0, 1);
    }

    // Pickups.
    for (const item of world.pickups) {
      if (item.respawn > 0) {
        item.respawn -= dt;
        continue;
      }
      for (const s of this.sleds) {
        if (s.remote || s.gone) continue;
        if (Math.hypot(s.pos.x - item.x, s.pos.z - item.z) > 2.3 || Math.abs(s.pos.y + 1 - item.y) > 2.6) continue;
        if (item.kind === 'repair') {
          // Nothing to mend: leave it for someone who needs it.
          if (s.damage < 0.05) continue;
          s.damage = 0;
        } else if (item.kind === 'boost') s.boost = 1;
        else if (item.kind === 'shield') s.shield = true;
        else s.item = 'snowball';
        item.respawn = 7;
        if (s === p) this.events.push('pickup');
        break;
      }
    }

    // Throwing: the player on a key press, AI riders when someone is lined up ahead.
    for (const s of this.sleds) {
      if (s.remote || s.gone || !s.item) continue;
      let fire = s === p && !this.autopilot ? !!s.input.item : false;
      if (s !== p || this.autopilot) {
        fire = this.sleds.some((o) => o !== s && !o.gone && o.progress - s.progress > 6 && o.progress - s.progress < 55 && Math.abs(o.lateral - s.lateral) < 3);
      }
      if (!fire) continue;
      s.item = null;
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xbfd9ee, emissiveIntensity: 0.6 }));
      world.scene.add(mesh);
      this.snowballs.push({ s: s.idx * track.ds + 3, lateral: s.lateral, speed: s.speed + 34, owner: s, life: 3.5, mesh });
      if (s === p) this.events.push('throw');
    }

    // Snowballs fly down the course in their lane until they hit someone or melt.
    for (let k = this.snowballs.length - 1; k >= 0; k--) {
      const b = this.snowballs[k];
      b.s += b.speed * dt;
      b.life -= dt;
      const i = track.wrap(Math.round(b.s / track.ds));
      const x = track.px[i] + track.lx[i] * b.lateral;
      const z = track.pz[i] + track.lz[i] * b.lateral;
      b.mesh.position.set(x, world.ground(x, z, i) + 0.9, z);
      let done = b.life <= 0 || (!track.closed && i >= track.n - 1);
      for (let slot = 0; slot < this.sleds.length && !done; slot++) {
        const o = this.sleds[slot];
        if (o === b.owner || o.gone || o.finished) continue;
        let gap = (o.idx - i) * track.ds;
        if (track.closed) gap = ((gap + track.length * 1.5) % track.length) - track.length / 2;
        if (Math.abs(gap) > 3 || Math.abs(o.lateral - b.lateral) > 1.8) continue;
        // A sled driven on another computer has to be told it was hit.
        if (o.remote) this.pendingHits.push(slot);
        else {
          o.struck();
          if (o === p) this.events.push('struck');
        }
        done = true;
      }
      if (done) {
        world.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        (b.mesh.material as THREE.Material).dispose();
        this.snowballs.splice(k, 1);
      }
    }
  }

  /** A snowball thrown on another computer hit one of the sleds driven here. */
  hitSlot(slot: number) {
    const s = this.sleds[slot];
    if (!s || s.remote || s.gone) return;
    s.struck();
    if (s === this.player) this.events.push('struck');
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
      // Knocked-out riders rank below everyone still in, the last one out highest.
      if (a.eliminated || b.eliminated) {
        if (a.eliminated && b.eliminated) return b.elimOrder - a.elimOrder;
        return a.eliminated ? 1 : -1;
      }
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
      .filter((s) => !s.gone || s.eliminated)
      .sort((a, b) => a.place - b.place)
      .map((sled): Standing => {
        if (sled.eliminated) return { sled, place: sled.place, time: NaN, estimated: false, out: true };
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
    if (this.ghost) this.world.scene.remove(this.ghost);
    if (this.avalanche) this.world.scene.remove(this.avalanche.mesh);
    for (const b of this.snowballs) this.world.scene.remove(b.mesh);
    for (const item of this.world.pickups) item.respawn = 0;
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
