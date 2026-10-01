import * as THREE from 'three';
import './style.css';
import { TRACKS, Difficulty } from './tracks';
import { World } from './world';
import { Race } from './race';
import { SLED, Sled } from './sled';
import { Input } from './input';
import { AudioEngine } from './audio';
import { UI, HudState } from './ui';
import { loadSave, writeSave, resultKey } from './storage';
import { clamp, lerp, wrapAngle } from './util';

const STEP = 1 / 60;
const hexColor = (c: number) => '#' + c.toString(16).padStart(6, '0');

class Game {
  private renderer: THREE.WebGLRenderer;
  private camera = new THREE.PerspectiveCamera(62, 1, 0.3, 9000);
  private world: World | null = null;
  private race: Race | null = null;
  private input = new Input();
  private audio = new AudioEngine();
  private save = loadSave();
  private ui: UI;

  private mode: 'menu' | 'race' = 'menu';
  private paused = false;
  private busy = false;
  private trackIndex = 0;
  private acc = 0;
  private last = performance.now();
  private finishTimer = 0;
  private resultsShown = false;
  private banner = '';
  private bannerUntil = 0;
  private clock = 0;

  private camYaw = 0;
  private camY = 0;
  private camSnap = true;
  private focus = new THREE.Vector3();
  private headlight: THREE.SpotLight | null = null;

  constructor() {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.audio.muted = this.save.muted;

    this.ui = new UI(document.getElementById('ui')!, this.save, {
      onSelectTrack: (i) => {
        this.save.lastTrack = i;
        writeSave(this.save);
        void this.load(i, true);
      },
      onDifficulty: (d: Difficulty) => {
        this.save.difficulty = d;
        writeSave(this.save);
      },
      onStart: () => void this.startRace(this.ui.selectedTrack),
      onResume: () => this.setPaused(false),
      onRestart: () => void this.startRace(this.trackIndex),
      onQuit: () => void this.toMenu(),
      onNext: () => void this.startRace(Math.min(this.trackIndex + 1, TRACKS.length - 1)),
      onToggleMute: () => this.toggleMute(),
    });

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('pointerdown', () => this.audio.start());
    window.addEventListener('keydown', () => this.audio.start());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'race' && !this.resultsShown) this.setPaused(true);
    });
    this.resize();

    void this.load(this.ui.selectedTrack, true);
    requestAnimationFrame((t) => this.frame(t));
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    // Keep menus and HUD readable on very large displays.
    document.getElementById('ui')!.style.zoom = String(clamp(Math.min(w / 1500, h / 800), 1, 2.2));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private toggleMute() {
    this.save.muted = !this.save.muted;
    this.audio.setMuted(this.save.muted);
    writeSave(this.save);
  }

  /** Builds (or reuses) a track's world and puts a fresh grid of racers on it. */
  private async load(index: number, attract: boolean) {
    if (this.busy) return;
    this.busy = true;
    const def = TRACKS[index];
    const rebuild = !this.world || this.world.def !== def;
    try {
      if (rebuild) {
        this.ui.showLoading(true);
        // Let the loading overlay paint before the heavy terrain build.
        await new Promise((r) => setTimeout(r, 40));
      }
      this.race?.dispose();
      this.race = null;
      if (rebuild) {
        this.world?.dispose();
        this.world = new World(def);
      }
      const world = this.world!;
      this.trackIndex = index;
      this.renderer.toneMappingExposure = world.theme.exposure;
      this.race = new Race(world, this.save.difficulty, attract);
      this.headlight = null;
      const lit = this.race.player ?? this.race.sleds[0];
      if (world.theme.night) this.headlight = addHeadlight(lit);
      this.camSnap = true;
      this.acc = 0;
      this.finishTimer = 0;
      this.resultsShown = false;
      this.banner = '';
    } catch (err) {
      console.error(err);
      this.ui.showError('The track could not be built. Check that your browser supports WebGL 2.');
    } finally {
      this.ui.showLoading(false);
      this.busy = false;
    }
  }

  private async startRace(index: number) {
    if (this.busy) return;
    this.audio.start();
    this.ui.closeModal();
    this.ui.showMenu(false);
    this.save.lastTrack = index;
    writeSave(this.save);
    await this.load(index, false);
    this.mode = 'race';
    this.paused = false;
    this.ui.selectTrack(index);
    this.ui.showHud(true, TRACKS[index]);
  }

  private async toMenu() {
    if (this.busy) return;
    this.ui.closeModal();
    this.ui.showHud(false);
    this.mode = 'menu';
    this.paused = false;
    await this.load(this.trackIndex, true);
    this.ui.showMenu(true);
  }

  private setPaused(p: boolean) {
    if (this.mode !== 'race' || this.resultsShown) return;
    this.paused = p;
    if (p) this.ui.showPause();
    else this.ui.closeModal();
  }

  private frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const race = this.race;
    const world = this.world;
    if (!race || !world || this.busy) {
      this.input.endFrame();
      return;
    }

    if (this.input.consume('KeyM')) {
      this.toggleMute();
      if (this.mode === 'menu') this.ui.renderMenu();
    }
    if (this.mode === 'race') {
      if (this.input.consume('Escape', 'KeyP')) {
        if (this.paused) this.setPaused(false);
        else if (!this.ui.modalOpen) this.setPaused(true);
      }
      if (this.input.consume('KeyR') && !this.paused && race.player && race.phase === 'racing') {
        race.player.resetToTrack(world);
      }
    }

    const player = race.player;
    if (!this.paused) {
      this.clock += dt;
      const inp = this.mode === 'race' ? this.input.read(dt) : null;
      this.acc += dt;
      let steps = 0;
      while (this.acc >= STEP && steps < 4) {
        race.step(STEP, inp);
        this.acc -= STEP;
        steps++;
      }
      if (steps === 4) this.acc = 0;
      this.handleEvents(race);
      if (race.phase === 'finished' && !this.resultsShown) {
        this.finishTimer += dt;
        if (this.finishTimer > 2.4) this.showResults(race);
      }
    }
    this.input.endFrame();

    const racing = this.mode === 'race' && !this.paused && !!player;
    this.audio.setEngine(
      player ? player.speed / SLED.maxSpeed : 0,
      player ? player.input.throttle : 0,
      !!player?.boosting,
      racing,
    );

    const target = player ?? race.sleds.reduce((a, b) => (a.place < b.place ? a : b));
    if (!this.paused) this.updateCamera(dt, target, world, !player);
    world.update(this.paused ? 0 : dt, this.camera, this.focus.copy(target.pos));
    if (this.mode === 'race' && player) this.ui.updateHud(this.hudState(race, player));
    this.renderer.render(world.scene, this.camera);
  }

  private handleEvents(race: Race) {
    for (const e of race.events) {
      if (e === 'count') this.audio.beep(440, 0.18);
      else if (e === 'go') this.audio.beep(880, 0.5, 0.3);
      else if (e === 'lap') this.audio.beep(660, 0.2);
      else if (e === 'final-lap') {
        this.audio.beep(660, 0.15);
        setTimeout(() => this.audio.beep(880, 0.25), 160);
        this.flash('FINAL LAP', 2.2);
      } else if (e === 'finish') {
        this.audio.fanfare();
        this.flash('FINISH!', 2.4);
      }
    }
    race.events.length = 0;
    for (const s of race.sleds) {
      if (s === race.player && s.impact > 4) this.audio.thud(s.impact);
      s.impact = 0;
    }
  }

  private flash(text: string, seconds: number) {
    this.banner = text;
    this.bannerUntil = this.clock + seconds;
  }

  private hudState(race: Race, player: Sled): HudState {
    const track = race.world.track;
    let banner = '';
    let tone: HudState['bannerTone'] = '';
    if (race.phase === 'countdown') {
      banner = String(Math.max(1, Math.ceil(race.countdown - 0.6)));
      tone = 'count';
    } else if (race.countdown > 0) {
      banner = 'GO!';
      tone = 'go';
    } else if (race.wrongWay > 0.8) {
      banner = 'WRONG WAY';
      tone = 'warn';
    } else if (this.clock < this.bannerUntil) {
      banner = this.banner;
      tone = 'info';
    }

    let hint = '';
    if (race.phase === 'countdown') hint = 'W / ↑ throttle  ·  A D / ← → steer  ·  Shift boost  ·  Esc pause';
    else if (race.phase === 'racing' && race.stranded > 2) hint = 'Press R to reset onto the track';

    return {
      place: player.place,
      total: race.sleds.length,
      lapLabel: track.closed ? 'LAP' : 'RUN',
      lapValue: track.closed ? `${race.playerLap}/${track.def.laps}` : `${Math.round(race.playerFraction() * 100)}%`,
      time: player.finished ? player.finishTime : race.time,
      speedKmh: player.speed * 3.6,
      boost: player.boost,
      boosting: player.boosting,
      banner,
      bannerTone: tone,
      hint,
      racers: race.sleds.map((s) => ({ x: s.pos.x, z: s.pos.z, color: hexColor(s.color), isPlayer: s.isPlayer })),
    };
  }

  private showResults(race: Race) {
    this.resultsShown = true;
    const player = race.player!;
    const def = TRACKS[this.trackIndex];
    const key = resultKey(def.id, race.difficulty);
    const prev = this.save.results[key];
    const newBest = !!prev && player.finishTime < prev.bestTime;
    this.save.results[key] = {
      bestPlace: prev ? Math.min(prev.bestPlace, player.place) : player.place,
      bestTime: prev ? Math.min(prev.bestTime, player.finishTime) : player.finishTime,
    };
    let unlockedName: string | null = null;
    const nextIndex = this.trackIndex + 1;
    if (player.place <= 3 && nextIndex < TRACKS.length && this.save.unlocked <= nextIndex) {
      this.save.unlocked = nextIndex + 1;
      unlockedName = TRACKS[nextIndex].name;
    }
    writeSave(this.save);
    this.ui.showResults({
      track: def,
      difficulty: race.difficulty,
      standings: race.standings(),
      playerPlace: player.place,
      playerTime: player.finishTime,
      newBest,
      unlockedName,
      hasNext: nextIndex < TRACKS.length && this.save.unlocked > nextIndex,
    });
  }

  private updateCamera(dt: number, sled: Sled, world: World, orbit: boolean) {
    const cam = this.camera;
    if (orbit) {
      // Menu backdrop: a slow orbit around the leader of the demo race.
      const a = this.clock * 0.12 + 0.6;
      const yaw = sled.yaw + Math.PI + Math.sin(a) * 1.1;
      const x = sled.pos.x - Math.sin(yaw) * -11;
      const z = sled.pos.z - Math.cos(yaw) * -11;
      const y = Math.max(sled.pos.y + 3.2, world.terrain.height(x, z) + 1.5);
      const k = this.camSnap ? 1 : 1 - Math.exp(-3 * dt);
      cam.position.lerp(_v.set(x, y, z), k);
      cam.fov = 55;
      cam.updateProjectionMatrix();
      cam.lookAt(sled.pos.x, sled.pos.y + 1, sled.pos.z);
      this.camSnap = false;
      return;
    }

    // Chase camera: sits behind the direction of travel, so drifts show as sled rotation.
    const speed = sled.speed;
    let want = sled.yaw;
    if (speed > 6) want += wrapAngle(Math.atan2(sled.vel.x, sled.vel.z) - sled.yaw) * 0.5;
    if (this.camSnap) {
      this.camYaw = want;
      this.camY = sled.pos.y + 3.1;
    }
    this.camYaw += wrapAngle(want - this.camYaw) * (1 - Math.exp(-6 * dt));
    const ratio = clamp(speed / SLED.maxSpeed, 0, 1.3);
    const dist = 6.8 + ratio * 1.6;
    const x = sled.pos.x - Math.sin(this.camYaw) * dist;
    const z = sled.pos.z - Math.cos(this.camYaw) * dist;
    this.camY = lerp(this.camY, sled.pos.y + 3.1, 1 - Math.exp(-7 * dt));
    const y = Math.max(this.camY, world.terrain.height(x, z) + 1.3);
    cam.position.set(x, y, z);
    cam.lookAt(sled.pos.x + Math.sin(this.camYaw) * 6, sled.pos.y + 1.5, sled.pos.z + Math.cos(this.camYaw) * 6);
    const fov = 62 + ratio * 14 + (sled.boosting ? 5 : 0);
    cam.fov = lerp(cam.fov, fov, 1 - Math.exp(-4 * dt));
    cam.updateProjectionMatrix();
    this.camSnap = false;
  }
}

const _v = new THREE.Vector3();

function addHeadlight(sled: Sled) {
  const light = new THREE.SpotLight(0xfff0cf, 420, 110, 0.5, 0.7, 1.5);
  light.position.set(0, 1.0, 1.3);
  light.target.position.set(0, 0, 26);
  sled.model.group.add(light, light.target);
  return light;
}

const game = new Game();
// Handle for debugging from the browser console.
(window as unknown as { __game: Game }).__game = game;
