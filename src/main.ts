import * as THREE from 'three';
import './style.css';
import { TRACKS, Difficulty, ALL_SURFACES, SurfaceOptions } from './tracks';
import { World } from './world';
import { Race, NetRace, RACERS, AI_NAMES, RIDER_COLORS } from './race';
import { NetSession, StartMsg, GridEntry, cleanCode, cleanName } from './net';
import { SLED, Sled } from './sled';
import { Input } from './input';
import { AudioEngine } from './audio';
import { UI, HudState, RoomView } from './ui';
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
  private last = performance.now();
  private finishTimer = 0;
  private resultsShown = false;
  private banner = '';
  private bannerUntil = 0;
  private clock = 0;

  private camYaw = 0;
  private camY = 0;
  private camTilt = 0;
  private camSnap = true;
  private focus = new THREE.Vector3();
  private headlight: THREE.SpotLight | null = null;

  private mirrorCam = new THREE.PerspectiveCamera(52, 3.6, 0.3, 9000);
  private mirrorTarget = new THREE.WebGLRenderTarget(512, 142);
  private hudScene = new THREE.Scene();
  private hudCam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  /** Flipped left-to-right (negative X scale), so it reads as a mirror rather than a rear camera. */
  private mirrorQuad = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: this.mirrorTarget.texture, side: THREE.DoubleSide, depthTest: false, fog: false }),
  );

  private net: NetSession | null = null;
  private netTimer = 0;
  private standingsTimer = 0;

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
        if (!this.net) this.save.lastTrack = i;
        writeSave(this.save);
        this.net?.setSelection(i, this.save.difficulty);
        void this.load(i, true);
      },
      onDifficulty: (d: Difficulty) => {
        this.save.difficulty = d;
        writeSave(this.save);
        this.net?.setSelection(this.ui.selectedTrack, d);
        this.syncRoom();
      },
      onStart: () => {
        if (this.net) this.hostStartOnline();
        else void this.startRace(this.ui.selectedTrack);
      },
      onOnline: (action, name, code) => this.goOnline(action, name, code),
      onLeaveRoom: () => this.leaveRoom(),
      onResume: () => this.setPaused(false),
      onRestart: () => void this.startRace(this.trackIndex),
      onQuit: () => void this.toMenu(),
      onNext: () => void this.startRace(Math.min(this.trackIndex + 1, TRACKS.length - 1)),
      onToggleMute: () => this.toggleMute(),
      onSetting: (key, on) => {
        if (key === 'sound') {
          if (on === this.save.muted) this.toggleMute();
          return;
        }
        if (key === 'mirror') this.save.mirror = on;
        else this.save.surfaces[key] = on;
        writeSave(this.save);
        // A surface change means a different road: rebuild the one behind the menu.
        if (key !== 'mirror' && this.mode === 'menu') void this.load(this.net ? this.net.lobby.track : this.ui.selectedTrack, true);
      },
    });

    this.hudScene.add(this.mirrorQuad);
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('pointerdown', () => this.audio.start());
    window.addEventListener('keydown', () => this.audio.start());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'race' && !this.resultsShown && !this.race?.online) this.setPaused(true);
    });
    this.resize();

    window.addEventListener('pagehide', () => this.net?.leave());

    void this.load(this.ui.selectedTrack, true);
    requestAnimationFrame((t) => this.frame(t));

    // An invite link opens straight into the join dialog.
    const invite = cleanCode(new URLSearchParams(location.search).get('room') ?? '');
    if (invite.length === 4) this.ui.showOnline(invite);
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    // Keep menus and HUD readable on very large displays.
    const zoom = clamp(Math.min(w / 1500, h / 800), 1, 2.2);
    document.getElementById('ui')!.style.zoom = String(zoom);

    // Rear-view mirror: a strip at the top centre, drawn by the renderer and framed by the HUD.
    const mw = clamp(w * 0.24, 250, 580);
    const mh = mw / 3.6;
    const my = 12 * zoom;
    this.mirrorQuad.scale.set(-mw, mh, 1);
    this.mirrorQuad.position.set(w / 2, h - my - mh / 2, 0);
    this.hudCam.right = w;
    this.hudCam.top = h;
    this.hudCam.updateProjectionMatrix();
    const dpr = this.renderer.getPixelRatio();
    this.mirrorTarget.setSize(Math.round(mw * dpr), Math.round(mh * dpr));
    this.ui.placeMirror(mw / zoom, mh / zoom, my / zoom);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private toggleMute() {
    this.save.muted = !this.save.muted;
    this.audio.setMuted(this.save.muted);
    writeSave(this.save);
  }

  /** Builds (or reuses) a track's world and puts a fresh grid of racers on it. */
  private async load(
    index: number,
    attract: boolean,
    difficulty = this.save.difficulty,
    net: NetRace | null = null,
    surfaces: SurfaceOptions = this.save.surfaces,
  ) {
    if (this.busy) return;
    this.busy = true;
    const def = TRACKS[index];
    const s = this.world?.surfaces;
    const sameRoad = !!s && s.ice === surfaces.ice && s.stone === surfaces.stone && s.grass === surfaces.grass;
    const rebuild = !this.world || this.world.def !== def || !sameRoad;
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
        this.world = new World(def, { ...surfaces });
      }
      const world = this.world!;
      this.trackIndex = index;
      this.renderer.toneMappingExposure = world.theme.exposure;
      this.race = new Race(world, difficulty, attract, net);
      this.headlight = null;
      const lit = this.race.player ?? this.race.sleds[0];
      if (world.theme.night) this.headlight = addHeadlight(lit);
      this.camSnap = true;
      this.finishTimer = 0;
      this.standingsTimer = 0;
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
    await this.whenIdle();
    if (this.net && this.race?.online) {
      // Leaving an online race: the host ends it for everyone, a guest just drops out.
      if (this.net.isHost) this.net.hostEnd();
      else if (this.race.player) this.net.sendState({ ...this.race.netStates(false)[0], x: 1 });
    }
    this.ui.closeModal();
    this.ui.showHud(false);
    this.mode = 'menu';
    this.paused = false;
    await this.load(this.net ? this.net.lobby.track : this.trackIndex, true);
    this.ui.showMenu(true);
    this.syncRoom();
  }

  private setPaused(p: boolean) {
    if (this.mode !== 'race' || this.resultsShown) return;
    // An online race can't stop for one player; the menu just overlays it.
    const online = !!this.race?.online;
    this.paused = p && !online;
    if (p) this.ui.showPause(online);
    else this.ui.closeModal();
  }

  /** Resolves once no track is being loaded. */
  private async whenIdle() {
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
  }

  // ---------- Online ----------

  private roomView(): RoomView | null {
    const net = this.net;
    if (!net) return null;
    return {
      code: net.code,
      isHost: net.isHost,
      racing: net.lobby.racing && this.mode === 'menu',
      track: net.lobby.track,
      difficulty: net.lobby.difficulty,
      players: net.lobby.players.map((p, i) => ({ name: p.name, me: p.id === net.myId, host: i === 0 })),
    };
  }

  private syncRoom() {
    if (this.net) this.ui.setRoom(this.roomView());
  }

  private async goOnline(action: 'host' | 'join', name: string, code: string) {
    this.audio.start();
    const rider = cleanName(name);
    this.save.playerName = rider;
    writeSave(this.save);
    const net =
      action === 'host'
        ? await NetSession.host(rider, this.ui.selectedTrack, this.save.difficulty)
        : await NetSession.join(cleanCode(code), rider);
    this.net?.leave();
    this.net = net;

    net.onLobby = () => {
      this.syncRoom();
      // Guests follow the host's track choice on the menu backdrop.
      if (!net.isHost && this.mode === 'menu' && net.lobby.track !== this.trackIndex) void this.load(net.lobby.track, true);
    };
    net.onStart = (msg) => void this.startOnline(msg);
    net.onGo = () => {
      if (this.race?.online) this.race.begin();
    };
    net.onEnd = () => {
      if (this.mode === 'race' && this.race?.online) void this.toMenu();
    };
    net.onStates = (list, from) => {
      if (this.mode === 'race' && this.race?.online) this.race.applyNet(list, net.isHost ? from : null);
    };
    net.onPlayerLeft = (id) => {
      if (this.race?.online) this.race.markGone(id);
    };
    net.onClosed = (reason) => {
      const inRace = this.mode === 'race' && !!this.race?.online;
      this.clearRoom();
      void (inRace ? this.toMenu() : Promise.resolve()).then(() => this.ui.showNotice('Disconnected', reason));
    };
    history.replaceState(null, '', `?room=${net.code}`);
    net.onLobby();
  }

  private clearRoom() {
    this.net = null;
    this.ui.setRoom(null);
    history.replaceState(null, '', location.pathname);
  }

  private leaveRoom() {
    this.net?.leave();
    this.clearRoom();
  }

  /** Host: build the grid (AI up front, players behind) and send everyone to the start. */
  private hostStartOnline() {
    const net = this.net;
    if (!net || !net.isHost || this.busy) return;
    const humans = net.lobby.players.slice(0, RACERS);
    const grid: GridEntry[] = [];
    for (let k = 0; k < RACERS - humans.length; k++) {
      grid.push({ kind: 'ai', id: '', name: AI_NAMES[k], color: RIDER_COLORS[RACERS - 1 - k] });
    }
    humans.forEach((p, i) => grid.push({ kind: 'human', id: p.id, name: p.name, color: RIDER_COLORS[i] }));
    const msg: StartMsg = { t: 'start', track: this.ui.selectedTrack, difficulty: this.save.difficulty, grid, surfaces: { ...this.save.surfaces } };
    net.hostStart(msg);
    void this.startOnline(msg);
  }

  private async startOnline(msg: StartMsg) {
    const net = this.net;
    if (!net) return;
    this.audio.start();
    await this.whenIdle();
    this.ui.closeModal();
    this.ui.showMenu(false);
    await this.load(msg.track, false, msg.difficulty, { grid: msg.grid, localId: net.myId, isHost: net.isHost }, msg.surfaces ?? ALL_SURFACES);
    this.mode = 'race';
    this.paused = false;
    this.netTimer = 0;
    this.ui.selectTrack(msg.track);
    this.ui.showHud(true, TRACKS[msg.track]);
    net.sendReady();
  }

  private frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    // Never zero: the physics divides by it.
    const dt = clamp((now - this.last) / 1000, 0.001, 0.05);
    this.last = now;
    const race = this.race;
    const world = this.world;
    if (!race || !world || this.busy) {
      this.input.endFrame();
      return;
    }

    if (this.input.consume('KeyV')) {
      this.save.mirror = !this.save.mirror;
      writeSave(this.save);
    }
    if (this.input.consume('KeyM')) {
      this.toggleMute();
      if (this.mode === 'menu') this.ui.renderMenu();
    }
    if (this.mode === 'race') {
      if (this.input.consume('Escape', 'KeyP')) {
        if (this.paused || (race.online && this.ui.modalOpen && !this.resultsShown)) this.setPaused(false);
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
      // Simulate exactly up to this frame, in slices no longer than STEP, so
      // motion stays smooth on high-refresh displays.
      const steps = Math.max(1, Math.ceil(dt / STEP));
      for (let i = 0; i < steps; i++) race.step(dt / steps, inp);
      this.handleEvents(race);
      if (race.phase === 'finished' && !this.resultsShown) {
        this.finishTimer += dt;
        if (this.finishTimer > 2.4) this.showResults(race);
      }
      if (this.net && race.online) {
        // Exchange positions about 20 times a second.
        this.netTimer += dt;
        if (this.netTimer >= 0.05) {
          this.netTimer = 0;
          if (this.net.isHost) this.net.sendWorld(race.netStates(true));
          else if (player) this.net.sendState(race.netStates(false)[0]);
        }
        // Keep the results table current while other riders are still finishing.
        if (this.resultsShown && (this.standingsTimer += dt) >= 1) {
          this.standingsTimer = 0;
          this.ui.refreshStandings(race.standings());
        }
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
    const mirror = this.mode === 'race' && !!player && this.save.mirror;
    this.ui.showMirror(mirror);
    if (mirror && player) this.renderMirror(world, player);
  }

  /** Draws what's behind the sled into the mirror strip. */
  private renderMirror(world: World, sled: Sled) {
    const r = this.renderer;
    const mc = this.mirrorCam;
    const fx = Math.sin(sled.yaw);
    const fz = Math.cos(sled.yaw);
    // Looking back from the tail, so the rider's own sled isn't in the way.
    mc.position.set(sled.pos.x - fx * 1.7, sled.pos.y + 1.5, sled.pos.z - fz * 1.7);
    mc.lookAt(sled.pos.x - fx * 30, sled.pos.y + 0.4, sled.pos.z - fz * 30);
    // The shadows were just drawn for the main view; no need to do them again.
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.mirrorTarget);
    r.render(world.scene, mc);
    r.setRenderTarget(null);
    r.shadowMap.autoUpdate = true;
    r.autoClear = false;
    r.clearDepth();
    r.render(this.hudScene, this.hudCam);
    r.autoClear = true;
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
    if (race.phase === 'waiting') {
      banner = 'Waiting for riders…';
      tone = 'info';
    } else if (race.phase === 'countdown') {
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
      total: race.fieldSize,
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
    const online = race.online;
    const newBest = !online && !!prev && player.finishTime < prev.bestTime;
    // Online results don't count toward solo progression.
    if (!online) this.save.results[key] = {
      bestPlace: prev ? Math.min(prev.bestPlace, player.place) : player.place,
      bestTime: prev ? Math.min(prev.bestTime, player.finishTime) : player.finishTime,
    };
    let unlockedName: string | null = null;
    const nextIndex = this.trackIndex + 1;
    if (!online && player.place <= 3 && nextIndex < TRACKS.length && this.save.unlocked <= nextIndex) {
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
      online,
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
      const y = Math.max(sled.pos.y + 3.2, world.ground(x, z, sled.idx) + 1.5);
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
      this.camY = sled.pos.y + 2.8;
    }
    this.camYaw += wrapAngle(want - this.camYaw) * (1 - Math.exp(-6 * dt));
    const ratio = clamp(speed / SLED.maxSpeed, 0, 1.3);
    const dist = 6.2 + ratio * 1.2;
    const x = sled.pos.x - Math.sin(this.camYaw) * dist;
    const z = sled.pos.z - Math.cos(this.camYaw) * dist;
    this.camY = lerp(this.camY, sled.pos.y + 2.8, 1 - Math.exp(-7 * dt));
    const y = Math.max(this.camY, world.ground(x, z, sled.idx) + 1.3);
    cam.position.set(x, y, z);
    // Aim at the ground ahead rather than level with the sled, so the view tips down into a
    // drop and up a wall of a climb.
    const ax = sled.pos.x + Math.sin(this.camYaw) * 14;
    const az = sled.pos.z + Math.cos(this.camYaw) * 14;
    const ahead = clamp(world.ground(ax, az, sled.idx) - sled.pos.y, -9, 9);
    this.camTilt = this.camSnap ? ahead : lerp(this.camTilt, ahead, 1 - Math.exp(-5 * dt));
    cam.lookAt(ax, sled.pos.y + 1.5 + this.camTilt * 0.8, az);
    const fov = 64 + ratio * 20 + (sled.boosting ? 7 : 0);
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
