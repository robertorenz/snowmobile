import * as THREE from 'three';
import './style.css';
import { TRACKS, CUPS, CUP_POINTS, MEDAL_FACTORS, Difficulty, ALL_SURFACES, SurfaceOptions, Conditions, NORMAL_CONDITIONS, themeFor } from './tracks';
import { Commentator } from './commentary';
import { Podium } from './podium';
import { World } from './world';
import { Race, NetRace, RaceOptions, RACERS, AI_NAMES, RIDER_COLORS, aiSled } from './race';
import { SLEDS, sledById, paintById, tunedSled, UPGRADE_PRICES, RACE_COINS, MEDAL_COINS, CUP_COINS } from './sleds';
import { AIDriver } from './ai';
import { QUALITY, Quality, QualityDef, detectQuality } from './quality';
import { DIFFICULTIES } from './tracks';
import { buildSledModel } from './sledModel';
import { NetSession, StartMsg, GridEntry, cleanCode, cleanName } from './net';
import { SLED, Sled } from './sled';
import { Input } from './input';
import { AudioEngine } from './audio';
import { UI, HudState, RoomView, ResultsData } from './ui';
import { loadSave, writeSave, resultKey, loadGhost, saveGhost, RECORDS_KEPT } from './storage';
import { clamp, lerp, wrapAngle, formatTime, ordinal } from './util';

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

  /** The championship in progress: which cup, which race of it, and points so far by rider name. */
  private champ: { cup: number; race: number; points: Record<string, number> } | null = null;

  private net: NetSession | null = null;
  private netTimer = 0;
  private standingsTimer = 0;

  constructor() {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    // Graphics level: the saved choice, or a guess from the hardware the first time.
    this.quality = this.save.quality === 'auto' ? detectQuality() : this.save.quality;
    this.q = QUALITY[this.quality];
    this.scaleMax = Math.min(window.devicePixelRatio, this.q.pixelRatio);
    this.scale = this.scaleMax;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.q.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.scale);
    this.renderer.shadowMap.enabled = this.q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.audio.muted = this.save.muted;
    this.audio.setMusic(this.save.music);

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
        if (this.net) {
          // The host can run a cup for the room: four races, points for everyone.
          if (this.save.mode === 'championship') {
            this.champ = { cup: this.save.cup, race: 0, points: {} };
            this.hostStartOnline(CUPS[this.save.cup].tracks[0]);
          } else {
            this.champ = null;
            this.hostStartOnline();
          }
        }
        else if (this.save.mode === 'championship') {
          this.champ = { cup: this.save.cup, race: 0, points: {} };
          void this.startRace(CUPS[this.save.cup].tracks[0]);
        } else void this.startRace(this.ui.selectedTrack);
      },
      onConditions: (season, night) => {
        this.save.season = season;
        this.save.night = night;
        writeSave(this.save);
        // Show the new season behind the menu.
        if (this.mode === 'menu') void this.load(this.net ? this.net.lobby.track : this.ui.selectedTrack, true);
      },
      onMode: (mode) => {
        this.save.mode = mode;
        writeSave(this.save);
      },
      onCup: (i) => {
        this.save.cup = i;
        writeSave(this.save);
        void this.load(CUPS[i].tracks[0], true);
      },
      onOnline: (action, name, code) => this.goOnline(action, name, code),
      onLeaveRoom: () => this.leaveRoom(),
      onResume: () => this.setPaused(false),
      onRestart: () => void this.startRace(this.trackIndex),
      onQuit: () => {
        this.champ = null;
        void this.toMenu();
      },
      onNext: () => {
        // In a championship, on to the cup's next race; otherwise the next level.
        const c = this.champ;
        if (c) {
          c.race++;
          if (this.net) this.hostStartOnline(CUPS[c.cup].tracks[c.race]);
          else void this.startRace(CUPS[c.cup].tracks[c.race]);
        } else void this.startRace(Math.min(this.trackIndex + 1, TRACKS.length - 1));
      },
      onToggleMute: () => this.toggleMute(),
      quality: () => ({ level: this.quality, auto: this.save.quality === 'auto' }),
      onQuality: (level) => {
        // Shadows, smoothing and the forest are all decided when things are built, so start afresh.
        this.save.quality = level;
        writeSave(this.save);
        this.net?.leave();
        location.reload();
      },
      onSled: (id) => {
        this.save.sled = sledById(id).id;
        writeSave(this.save);
        this.net?.setSled(this.save.sled);
      },
      sledThumb: (id) => this.sledThumb(id),
      onPaint: (id) => {
        const paint = paintById(id);
        if (!this.save.paints.includes(paint.id)) {
          if (this.save.coins < paint.price) return false;
          this.save.coins -= paint.price;
          this.save.paints.push(paint.id);
        }
        this.save.paint = paint.id;
        writeSave(this.save);
        return true;
      },
      onChat: (text) => this.net?.sendChat(text),
      onUpgrade: (id) => {
        const level = this.save.upgrades[id];
        const price = UPGRADE_PRICES[level];
        if (price === undefined || this.save.coins < price) return false;
        this.save.coins -= price;
        this.save.upgrades[id] = level + 1;
        writeSave(this.save);
        return true;
      },
      onStripe: (color) => {
        this.save.stripe = color;
        writeSave(this.save);
      },
      onReplay: () => this.startReplay(),
      onWatch: () => this.startWatching(),
      onBarBack: () => this.backToResults(),
      onPhoto: () => this.enterPhoto(),
      onPhotoSave: () => this.savePhoto(),
      onPhotoExit: () => this.exitPhoto(),
      onSetting: (key, on) => {
        if (key === 'sound') {
          if (on === this.save.muted) this.toggleMute();
          return;
        }
        if (key === 'music') {
          this.save.music = on;
          this.audio.setMusic(on);
          writeSave(this.save);
          return;
        }
        if (key === 'mirror' || key === 'commentary' || key === 'voice' || key === 'slowmo') {
          this.save[key] = on;
          if (!on && (key === 'commentary' || key === 'voice')) this.commentator.reset();
          writeSave(this.save);
          return;
        }
        this.save.surfaces[key] = on;
        writeSave(this.save);
        // A surface change means a different road: rebuild the one behind the menu.
        if (this.mode === 'menu') void this.load(this.net ? this.net.lobby.track : this.ui.selectedTrack, true);
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

    // Photo mode: drag to look round the sled, scroll to move in and out.
    let drag: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (this.photo) drag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointerup', () => (drag = null));
    window.addEventListener('pointermove', (e) => {
      if (!this.photo || !drag) return;
      this.photo.yaw -= (e.clientX - drag.x) * 0.006;
      this.photo.pitch = clamp(this.photo.pitch + (e.clientY - drag.y) * 0.004, -0.08, 1.35);
      drag = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('wheel', (e) => {
      // While racing, the wheel moves a raised view out (scroll down) or in.
      if (!this.photo && this.mode === 'race' && !this.paused) this.stepZoom(e.deltaY > 0 ? 1 : -1, false);
      if (this.photo) this.photo.dist = clamp(this.photo.dist * (1 + e.deltaY * 0.001), 3, 45);
    }, { passive: true });

    void this.load(this.ui.selectedTrack, true);
    requestAnimationFrame((t) => this.frame(t));

    // An invite link opens straight into the join dialog.
    const invite = cleanCode(new URLSearchParams(location.search).get('room') ?? '');
    if (invite.length === 4) this.ui.showOnline(invite);
  }

  private quality: Quality = 'high';
  private q: QualityDef = QUALITY.high;
  /** Pixels drawn per screen pixel right now, and the most this graphics level allows. */
  private scale = 1;
  private scaleMax = 1;
  private slow = 0;
  private fast = 0;

  /**
   * Keeps the game playable on slow machines by drawing fewer pixels when
   * frames are taking too long, and more again when there is time to spare.
   * Judged over a second or so at a time, so one hitch doesn't trigger it.
   */
  /** Steps the height of whichever raised view is in use: 1 to 4, wrapping round when asked to. */
  private stepZoom(by: number, wrap: boolean) {
    const s = this.save;
    if (s.camera !== 'high' && s.camera !== 'top') return;
    const key = s.camera === 'high' ? 'highZoom' : 'topZoom';
    const next = (s[key] || 1) + by;
    s[key] = wrap ? ((next - 1 + 4) % 4) + 1 : clamp(next, 1, 4);
    writeSave(s);
    this.announceView();
  }

  private announceView() {
    const s = this.save;
    const times = (n: number) => (n > 1 ? `  x${n}` : '');
    const name = s.camera === 'top' ? 'BIRD\'S-EYE VIEW' + times(s.topZoom) : s.camera === 'high' ? 'HIGH VIEW' + times(s.highZoom) : s.camera === 'rider' ? 'RIDER VIEW' : 'CHASE VIEW';
    this.flash(name, 1.1);
  }

  private adaptResolution(frame: number) {
    // Ignore pauses, tab switches and track loads.
    if (frame > 0.25 || this.busy || this.paused) return;
    this.slow = frame > 0.03 ? this.slow + 1 : Math.max(0, this.slow - 2);
    this.fast = frame < 0.013 ? this.fast + 1 : 0;
    let next = this.scale;
    if (this.slow > 45 && this.scale > 0.45) next = Math.max(0.45, this.scale - 0.1);
    else if (this.fast > 240 && this.scale < this.scaleMax) next = Math.min(this.scaleMax, this.scale + 0.1);
    if (next === this.scale) return;
    this.scale = next;
    this.slow = this.fast = 0;
    this.renderer.setPixelRatio(next);
    this.resize();
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
    opts: RaceOptions = {},
    cond: Conditions = this.conditions(),
  ) {
    if (this.busy) return;
    this.busy = true;
    this.endPodium(false);
    const def = TRACKS[index];
    const key = `${def.id}|${cond.season}|${cond.night}`;
    const s = this.world?.surfaces;
    const sameRoad = !!s && s.ice === surfaces.ice && s.stone === surfaces.stone && s.grass === surfaces.grass;
    const rebuild = !this.world || this.worldKey !== key || !sameRoad;
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
        // The same course, dressed for the season and time of day.
        this.world = new World({ ...def, theme: themeFor(def, cond) }, { ...surfaces }, this.q);
        this.worldKey = key;
      }
      const world = this.world!;
      this.trackIndex = index;
      this.renderer.toneMappingExposure = world.theme.exposure;
      this.race = new Race(world, difficulty, attract, net, this.save.sled, opts);
      this.headlight = null;
      const lit = this.race.player ?? this.race.sleds[0];
      if (world.theme.night || world.theme.dusk) this.headlight = addHeadlight(lit, world.theme.night);
      // In the dark every sled shows a headlamp and a tail light.
      if (world.theme.night) this.race.sleds.forEach(addLamps);
      this.commentator.reset();
      this.slowLeft = this.slowCool = 0;
      this.timeScale = 1;
      world.setDarkness(0);
      this.camSnap = true;
      this.finishTimer = 0;
      this.standingsTimer = 0;
      this.resultsShown = false;
      this.banner = '';
      this.stopWatching();
    } catch (err) {
      console.error(err);
      this.ui.showError('The track could not be built. Check that your browser supports WebGL 2.');
    } finally {
      this.ui.showLoading(false);
      this.busy = false;
    }
  }

  /** The key of the world that is built: track, season and time of day. */
  private worldKey = '';

  /** The season and time of day chosen on the menu. */
  private conditions(): Conditions {
    return { season: this.save.season, night: this.save.night };
  }

  private async startRace(index: number) {
    if (this.busy) return;
    this.audio.start();
    this.ui.closeModal();
    this.ui.showMenu(false);
    if (!this.champ) this.save.lastTrack = index;
    writeSave(this.save);
    // A cup is a series of ordinary races; the other modes are their own kind of race.
    const mode = this.champ || this.save.mode === 'championship' ? 'race' : this.save.mode;
    const ghost = mode === 'trial' ? loadGhost(TRACKS[index].id) : null;
    await this.load(index, false, this.save.difficulty, null, this.save.surfaces, {
      mode,
      ghost,
      paint: paintById(this.save.paint).color,
      tuned: tunedSled(sledById(this.save.sled), this.save.upgrades, this.save.stripe),
    });
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

  private thumbs = new Map<string, string>();

  /** A small picture of a snowmobile model, for the menu. Rendered once and kept. */
  private sledThumb(id: string) {
    const cacheKey = id + ':' + this.save.paint + ':' + this.save.stripe;
    const cached = this.thumbs.get(cacheKey);
    if (cached) return cached;
    const W = 360;
    const H = 210;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x12283d);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6f8499, 1.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(3, 6, 4);
    scene.add(key);
    const model = buildSledModel(paintById(this.save.paint).color, 0xf3f8fc, tunedSled(sledById(id), this.save.upgrades, this.save.stripe).shape);
    scene.add(model.group);
    const cam = new THREE.PerspectiveCamera(30, W / H, 0.1, 50);
    cam.position.set(4.4, 2.1, 3.6);
    cam.lookAt(0, 0.62, -0.05);
    const target = new THREE.WebGLRenderTarget(W, H);
    const r = this.renderer;
    r.setRenderTarget(target);
    r.render(scene, cam);
    const px = new Uint8Array(W * H * 4);
    r.readRenderTargetPixels(target, 0, 0, W, H, px);
    r.setRenderTarget(null);
    target.dispose();
    model.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (mat) for (const one of Array.isArray(mat) ? mat : [mat]) one.dispose();
    });
    // The target holds linear light and is upside down: convert to display values the right way up.
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = ((H - 1 - y) * W + x) * 4;
        const d = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) img.data[d + c] = Math.pow(Math.min(1, px[s + c] / 255), 1 / 2.2) * 255;
        img.data[d + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const url = canvas.toDataURL('image/jpeg', 0.9);
    this.thumbs.set(cacheKey, url);
    return url;
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
        ? await NetSession.host(rider, this.save.sled, this.ui.selectedTrack, this.save.difficulty)
        : await NetSession.join(cleanCode(code), rider, this.save.sled);
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
    net.onChat = (name, text) => this.ui.addChat(name, text);
    net.onHit = (slot) => {
      if (this.mode === 'race' && this.race?.online) this.race.hitSlot(slot);
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
  private hostStartOnline(track = this.ui.selectedTrack) {
    const net = this.net;
    if (!net || !net.isHost || this.busy) return;
    const humans = net.lobby.players.slice(0, RACERS);
    const grid: GridEntry[] = [];
    for (let k = 0; k < RACERS - humans.length; k++) {
      grid.push({ kind: 'ai', id: '', name: AI_NAMES[k], color: RIDER_COLORS[RACERS - 1 - k], sled: aiSled(k) });
    }
    humans.forEach((p, i) => grid.push({ kind: 'human', id: p.id, name: p.name, color: RIDER_COLORS[i], sled: p.sled }));
    const msg: StartMsg = { t: 'start', track, difficulty: this.save.difficulty, grid, surfaces: { ...this.save.surfaces }, cond: this.conditions() };
    if (this.champ) msg.cup = { cup: this.champ.cup, race: this.champ.race };
    net.hostStart(msg);
    void this.startOnline(msg);
  }

  private async startOnline(msg: StartMsg) {
    const net = this.net;
    if (!net) return;
    // Guests keep their own copy of the cup table, started afresh with the cup's first race.
    if (!msg.cup) this.champ = null;
    else if (!net.isHost) {
      if (msg.cup.race === 0 || !this.champ || this.champ.cup !== msg.cup.cup) this.champ = { cup: msg.cup.cup, race: msg.cup.race, points: {} };
      else this.champ.race = msg.cup.race;
    }
    this.stopWatching();
    this.audio.start();
    await this.whenIdle();
    this.ui.closeModal();
    this.ui.showMenu(false);
    await this.load(msg.track, false, msg.difficulty, { grid: msg.grid, localId: net.myId, isHost: net.isHost }, msg.surfaces ?? ALL_SURFACES, {}, msg.cond ?? NORMAL_CONDITIONS);
    this.mode = 'race';
    this.paused = false;
    this.netTimer = 0;
    this.ui.selectTrack(msg.track);
    this.ui.showHud(true, TRACKS[msg.track]);
    net.sendReady();
  }

  private frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    this.adaptResolution((now - this.last) / 1000);
    // Never zero: the physics divides by it.
    const dt = clamp((now - this.last) / 1000, 0.001, 0.05);
    this.last = now;
    const race = this.race;
    const world = this.world;
    if (!race || !world || this.busy) {
      this.input.endFrame();
      return;
    }

    if (this.input.consume('KeyC')) {
      // C steps through the three views.
      // C changes the kind of view: chase, rider, high behind, straight down.
      const s = this.save;
      s.camera = s.camera === 'chase' ? 'rider' : s.camera === 'rider' ? 'high' : s.camera === 'high' ? 'top' : 'chase';
      this.announceView();
      this.camSnap = true;
      writeSave(this.save);
    }
    // X (or the mouse wheel) moves the high and bird's-eye views further out and back in.
    if (this.input.consume('KeyX')) this.stepZoom(1, true);
    if (this.input.consume('KeyV')) {
      this.save.mirror = !this.save.mirror;
      writeSave(this.save);
    }
    if (this.input.consume('KeyM')) {
      this.toggleMute();
      if (this.mode === 'menu') this.ui.renderMenu();
    }
    if (this.mode === 'race') {
      if (this.podium) {
        if (this.input.consume('Escape', 'Enter', 'KeyP') || this.podiumT > 14) this.endPodium(true);
      } else if (this.replay || this.watch) {
        if (this.input.consume('Escape', 'KeyP', 'Enter')) this.backToResults();
        // Left and right switch which rider the camera follows.
        const step = (this.input.consume('ArrowRight', 'KeyD') ? 1 : 0) - (this.input.consume('ArrowLeft', 'KeyA') ? 1 : 0);
        if (step && this.watch) this.watchNext(race, step);
      } else if (this.photo) {
        if (this.input.consume('Escape', 'KeyP')) this.exitPhoto();
      } else if (this.input.consume('Escape', 'KeyP')) {
        if (this.paused || (race.online && this.ui.modalOpen && !this.resultsShown)) this.setPaused(false);
        else if (!this.ui.modalOpen) this.setPaused(true);
      }
      if (this.input.consume('KeyR') && !this.paused && race.player && race.phase === 'racing') {
        race.player.resetToTrack(world);
      }
    }

    const player = race.player;
    if (this.replay) {
      // Play the recording back on a loop.
      this.clock += dt;
      this.replay.t = (this.replay.t + dt) % Math.max(1, race.replayLength);
      race.showReplay(this.replay.t, dt);
    } else if (this.podium) {
      // Prize-giving: the race waits.
      this.clock += dt;
      this.podiumT += dt;
    } else if (!this.paused) {
      this.clock += dt;
      const inp = this.mode === 'race' ? this.input.read(dt) : null;
      // Big moments play out in slow motion: the race clock runs slow, the screen doesn't.
      const sim = dt * this.pace(race, world, dt);
      // Simulate exactly up to this frame, in slices no longer than STEP, so
      // motion stays smooth on high-refresh displays.
      const steps = Math.max(1, Math.ceil(sim / STEP));
      for (let i = 0; i < steps; i++) race.step(sim / steps, inp);
      if (this.mode === 'race' && this.save.commentary) this.commentator.update(race, race.events, dt);
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

    // Dusk tracks: the light goes as the race does, and the headlight comes up with it.
    if (world.theme.dusk) {
      const k = this.mode === 'race' ? clamp((race.playerFraction() - 0.12) / 0.7, 0, 1) : 0;
      world.setDarkness(k * k * (3 - 2 * k));
      if (this.headlight) this.headlight.intensity = 420 * world.darkness;
    }
    // Crowd noise near the start line; the train whistles when it comes out of its tunnel within earshot.
    if (player && this.mode === 'race') {
      const tr = world.track;
      const dStart = Math.hypot(player.pos.x - tr.px[tr.startIdx], player.pos.z - tr.pz[tr.startIdx]);
      this.audio.setCrowd(this.podium ? 1 : this.paused ? 0 : 1 - dStart / 130);
      const train = world.train;
      if (train.running && !this.trainWasRunning) this.audio.whistle(1 - player.pos.distanceTo(train.pos) / 420);
      this.trainWasRunning = train.running;
    } else this.audio.setCrowd(0);

    const racing = this.mode === 'race' && !this.paused && !!player;
    this.audio.setEngine(
      player ? player.speed / SLED.maxSpeed : 0,
      player ? player.input.throttle : 0,
      !!player?.boosting,
      racing,
    );

    const target = player ?? race.sleds.reduce((a, b) => (a.place < b.place ? a : b));
    if (this.podium) this.podium.update(dt, this.camera);
    else if (!this.paused) this.updateCamera(dt, this.watch ?? target, world, !player || !!this.replay);
    if (this.photo && player) this.photoCamera(player, world);
    world.update(this.paused ? 0 : dt, this.camera, this.focus.copy(target.pos));
    if (this.mode === 'race' && player) this.ui.updateHud(this.hudState(race, player));
    this.renderer.render(world.scene, this.camera);
    this.input.showTouch(this.mode === 'race' && !this.paused && !this.resultsShown);
    const mirror = this.mode === 'race' && !!player && this.save.mirror && this.q.mirror && !this.photo && !this.podium;
    this.ui.showMirror(mirror);
    if (mirror && player) this.renderMirror(world, player);
  }

  // ---------- Slow motion ----------

  private slowLeft = 0;
  private slowCool = 0;
  private timeScale = 1;
  private commentator = new Commentator(() => this.save.voice);

  /**
   * How fast the race clock should run this frame: 1 normally, about a
   * third for a moment on a big jump, a near miss with traffic or a close
   * finish. Solo races only, since an online race has one clock for everyone.
   */
  private pace(race: Race, world: World, dt: number) {
    const me = race.player;
    this.slowCool = Math.max(0, this.slowCool - dt);
    if (me && this.save.slowmo && this.mode === 'race' && !race.online && race.phase === 'racing' && this.slowLeft <= 0 && this.slowCool <= 0) {
      const gap = me.pos.y - world.ground(me.pos.x, me.pos.z, me.idx);
      const left = race.finishLine - me.progress;
      if (!me.grounded && me.airTime > 0.35 && (gap > 4.5 || (me.trickAngle > 0.5 && gap > 2.5))) this.slowLeft = 1.2;
      else if (me.speed > 14 && world.vehicles.some((v) => Math.hypot(v.x - me.pos.x, v.z - me.pos.z) < v.halfLength + 4.5)) this.slowLeft = 0.8;
      else if (left > 0 && left < 22 && me.speed > 10 && race.sleds.some((o) => o !== me && !o.gone && !o.finished && Math.abs(o.progress - me.progress) < 7)) this.slowLeft = 1.5;
      if (this.slowLeft > 0) this.slowCool = 12;
    }
    this.slowLeft = Math.max(0, this.slowLeft - dt);
    const target = this.slowLeft > 0 ? 0.3 : 1;
    this.timeScale += (target - this.timeScale) * (1 - Math.exp(-(target < 1 ? 14 : 5) * dt));
    return this.timeScale;
  }

  // ---------- Podium ----------

  private podium: Podium | null = null;
  private podiumT = 0;
  /** Set when a race ends: the prize-giving plays once, before the results. */
  private podiumDue = false;

  private startPodium(race: Race) {
    const top = race
      .standings()
      .filter((s) => !s.out)
      .slice(0, 3)
      .map((s) => s.sled);
    for (const s of race.sleds) s.model.group.visible = false;
    this.podium = new Podium(race.world, top);
    this.podiumT = 0;
    this.ui.closeModal();
    this.ui.showHud(false);
    this.ui.showBar(top.map((s, k) => `${ordinal(k + 1)}  ${s.name}`).join('   ·   '), 'Continue');
    this.audio.fanfare();
  }

  /** Clears the podium away and, if asked, moves on to the results. */
  private endPodium(showResults: boolean) {
    if (!this.podium) return;
    this.podium.dispose();
    this.podium = null;
    for (const s of this.race?.sleds ?? []) s.model.group.visible = !s.gone;
    this.ui.showBar(null);
    this.camSnap = true;
    if (showResults && this.lastResults) {
      this.ui.showHud(true, TRACKS[this.trackIndex]);
      this.ui.showResults(this.lastResults);
    }
  }

  // ---------- Photo mode ----------

  /** Free camera round the paused sled: where it is, in angles and distance. */
  private photo: { yaw: number; pitch: number; dist: number } | null = null;
  private trainWasRunning = false;

  private enterPhoto() {
    const player = this.race?.player;
    if (!player || this.race?.online) return;
    this.ui.closeModal();
    this.paused = true;
    this.photo = { yaw: player.yaw + 2.4, pitch: 0.28, dist: 7.5 };
    this.ui.showHud(false);
    this.ui.showPhotoBar(true);
  }

  private exitPhoto() {
    if (!this.photo) return;
    this.photo = null;
    this.ui.showPhotoBar(false);
    this.ui.showHud(true, TRACKS[this.trackIndex]);
    this.camSnap = true;
    this.ui.showPause(false);
  }

  private photoCamera(sled: Sled, world: World) {
    const ph = this.photo!;
    const cam = this.camera;
    cam.up.set(0, 1, 0);
    const flat = Math.cos(ph.pitch) * ph.dist;
    const x = sled.pos.x + Math.sin(ph.yaw) * flat;
    const z = sled.pos.z + Math.cos(ph.yaw) * flat;
    const y = Math.max(sled.pos.y + 0.9 + Math.sin(ph.pitch) * ph.dist, world.ground(x, z, sled.idx) + 0.5);
    cam.position.set(x, y, z);
    cam.fov = 45;
    cam.updateProjectionMatrix();
    cam.lookAt(sled.pos.x, sled.pos.y + 0.8, sled.pos.z);
  }

  /** Saves what's on screen as a PNG. The picture has to be read in the same frame it was drawn. */
  private savePhoto() {
    const world = this.world;
    if (!world) return;
    this.renderer.render(world.scene, this.camera);
    this.renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `powder-rush-${TRACKS[this.trackIndex].id}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
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
      } else if (e === 'avalanche') {
        this.flash('AVALANCHE!', 2.6);
        this.audio.thud(14);
      } else if (e === 'buried') {
        this.flash('BURIED', 1.6);
        this.audio.thud(12);
      } else if (e === 'knockout') {
        this.flash('KNOCKOUT', 1.2);
        this.audio.beep(330, 0.25);
      } else if (e === 'eliminated') {
        this.flash('KNOCKED OUT', 2.4);
        this.audio.thud(10);
      } else if (e === 'pickup') this.audio.beep(784, 0.12, 0.2);
      else if (e === 'throw') this.audio.beep(330, 0.1, 0.2);
      else if (e === 'struck') this.flash('HIT!', 1.0);
      else if (e === 'finish') {
        this.audio.fanfare();
        this.flash('FINISH!', 2.4);
      }
    }
    race.events.length = 0;
    const me = race.player;
    if (me && me.trickResult) {
      if (me.trickResult > 0) {
        this.flash(me.trickResult > 1 ? `${me.trickResult}x FLIP!` : 'FLIP!', 1.4);
        this.audio.beep(988, 0.12);
        setTimeout(() => this.audio.beep(1319, 0.2), 110);
      } else this.flash('WIPEOUT', 1.4);
      me.trickResult = 0;
    }
    // Tell the other computers about any of their sleds our snowballs hit.
    for (const slot of race.pendingHits) this.net?.sendHit(slot);
    race.pendingHits.length = 0;
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
      status: [
        race.mode === 'elimination' && race.phase === 'racing' ? `KNOCKOUT IN ${Math.ceil(race.knockoutIn)}s` : '',
        race.mode === 'elimination' && player.place === race.fieldSize && race.phase === 'racing' ? 'YOU ARE LAST' : '',
        race.mode === 'trial' ? `GOLD ${formatTime((track.def.par ?? 120) * MEDAL_FACTORS[0])}` : '',
        race.avalanche && player.progress > race.avalanche.front ? `AVALANCHE ${Math.round(player.progress - race.avalanche.front)} m BEHIND` : '',
        player.damage > 0.04 ? `DAMAGE ${Math.round(player.damage * 100)}%` : '',
        player.item ? 'SNOWBALL  ·  E to throw' : '',
        player.shield ? 'SHIELD' : '',
        player.draft > 0.5 ? 'SLIPSTREAM' : '',
        player.packed > 0.6 ? 'PACKED SNOW' : '',
      ].filter(Boolean),
      banner,
      bannerTone: tone,
      hint,
      commentary: this.save.commentary ? this.commentator.line : '',
      racers: race.sleds.map((s) => ({ x: s.pos.x, z: s.pos.z, color: hexColor(s.color), isPlayer: s.isPlayer })),
    };
  }

  private showResults(race: Race) {
    this.resultsShown = true;
    const player = race.player!;
    const def = TRACKS[this.trackIndex];
    const online = race.online;
    const standings = race.standings();
    this.podiumDue = !online && race.mode !== 'trial' && !player.eliminated && standings.length >= 3;
    // A full run of the course against the clock goes on the track's record board.
    let record = 0;
    if (!online && race.mode !== 'elimination' && player.finished && player.finishTime > 0) {
      const list = (this.save.records[def.id] ??= []);
      const entry = { time: player.finishTime, mode: race.mode, difficulty: race.difficulty, sled: this.save.sled, date: new Date().toISOString().slice(0, 10) };
      list.push(entry);
      list.sort((a, b) => a.time - b.time);
      list.length = Math.min(list.length, RECORDS_KEPT);
      record = list.indexOf(entry) + 1;
    }
    const base = {
      record,
      track: def,
      difficulty: race.difficulty,
      standings,
      playerPlace: player.place,
      playerTime: player.finishTime,
      newBest: false,
      unlockedName: null as string | null,
      hasNext: false,
      online,
    };

    // Time trial: a medal against the clock, and a new ghost if this was the best run yet.
    if (race.mode === 'trial') {
      const par = def.par ?? 120;
      const targets = MEDAL_FACTORS.map((k) => par * k);
      const time = player.finishTime;
      const medal = targets.findIndex((limit) => time <= limit);
      const before = this.save.trials[def.id];
      const improved = before === undefined || time < before;
      if (improved) {
        this.save.trials[def.id] = time;
        saveGhost(def.id, race.recording);
      }
      writeSave(this.save);
      const coins = medal >= 0 ? MEDAL_COINS[medal] : 0;
      this.save.coins += coins;
      writeSave(this.save);
      this.present({ ...base, coins, trial: { medal, targets, best: improved ? time : before, improved } });
      return;
    }

    // Solo races and knockouts count toward progression; online ones don't.
    const key = resultKey(def.id, race.difficulty);
    const prev = this.save.results[key];
    const timed = !player.eliminated;
    if (!online && timed) {
      base.newBest = !!prev && player.finishTime < prev.bestTime;
      this.save.results[key] = {
        bestPlace: prev ? Math.min(prev.bestPlace, player.place) : player.place,
        bestTime: prev ? Math.min(prev.bestTime, player.finishTime) : player.finishTime,
      };
    }
    const nextIndex = this.trackIndex + 1;
    if (!online && player.place <= 3 && nextIndex < TRACKS.length && this.save.unlocked <= nextIndex) {
      this.save.unlocked = nextIndex + 1;
      base.unlockedName = TRACKS[nextIndex].name;
    }
    base.hasNext = nextIndex < TRACKS.length && this.save.unlocked > nextIndex;

    // Championship: add this race's points and show the table.
    const c = this.champ;
    if (c) {
      const cup = CUPS[c.cup];
      for (const s of standings) c.points[s.sled.name] = (c.points[s.sled.name] ?? 0) + (CUP_POINTS[s.place - 1] ?? 0);
      const table = Object.entries(c.points)
        .map(([name, points]) => ({ name, points, me: name === player.name }))
        .sort((x, y) => y.points - x.points);
      const last = c.race >= cup.tracks.length - 1;
      const final = table.findIndex((row) => row.me) + 1;
      if (last && !online) this.save.cups[cup.id] = Math.min(this.save.cups[cup.id] ?? 99, final);
      const coins = online ? 0 : (RACE_COINS[player.place - 1] ?? 0) + (last ? (CUP_COINS[final - 1] ?? 0) : 0);
      this.save.coins += coins;
      writeSave(this.save);
      this.present({ ...base, coins, hasNext: !last, champ: { cup: cup.name, race: c.race + 1, races: cup.tracks.length, table, final: last ? final : 0 } });
      if (last) this.champ = null;
      return;
    }

    // Coins for every solo race; online ones are for fun.
    const coins = online ? 0 : (RACE_COINS[player.place - 1] ?? 0);
    this.save.coins += coins;
    writeSave(this.save);
    this.present({ ...base, coins, eliminated: player.eliminated });
  }

  // ---------- After the flag: replay and spectating ----------

  private lastResults: ResultsData | null = null;
  /** Playing the race back, and how far through. */
  private replay: { t: number } | null = null;
  /** The rider the camera is following while spectating. */
  private watch: Sled | null = null;

  /** Shows the results and remembers them, so they can be brought back after a replay. */
  private present(data: ResultsData) {
    const race = this.race;
    data.canWatch = !!race && race.sleds.some((s) => !s.isPlayer && !s.gone && !s.finished);
    data.canReplay = !!race && race.replayLength > 3;
    data.isHost = !!this.net?.isHost;
    this.lastResults = data;
    if (this.podiumDue && race) {
      this.podiumDue = false;
      this.startPodium(race);
      return;
    }
    this.ui.showResults(data);
  }

  private startReplay() {
    if (!this.race || this.race.replayLength < 3) return;
    this.ui.closeModal();
    this.ui.showHud(false);
    this.replay = { t: 0 };
    this.watch = null;
    this.camSnap = true;
    this.ui.showBar('Replay', 'Back to results');
  }

  private startWatching() {
    const race = this.race;
    if (!race) return;
    this.ui.closeModal();
    this.ui.showHud(false);
    this.replay = null;
    this.watch = race.player;
    this.watchNext(race, 1);
  }

  private watchNext(race: Race, step: number) {
    // Riders still on the course, in race order.
    const field = race.sleds.filter((s) => !s.gone && !s.isPlayer).sort((a, b) => a.place - b.place);
    if (!field.length) return;
    const at = this.watch ? field.indexOf(this.watch) : -1;
    this.watch = field[(at + step + field.length) % field.length];
    this.camSnap = true;
    this.ui.showBar(`Watching ${this.watch.name}  ·  ← → to switch`, 'Back to results');
  }

  private stopWatching() {
    this.replay = null;
    this.watch = null;
    this.ui.showBar(null);
  }

  private backToResults() {
    if (this.podium) {
      this.endPodium(true);
      return;
    }
    const race = this.race;
    this.stopWatching();
    this.camSnap = true;
    if (!race || !this.lastResults) return;
    this.lastResults.standings = race.standings();
    this.ui.showHud(true, TRACKS[this.trackIndex]);
    this.present(this.lastResults);
  }

  private updateCamera(dt: number, sled: Sled, world: World, orbit: boolean) {
    const cam = this.camera;
    // Every view but the overhead one keeps the horizon level.
    cam.up.set(0, 1, 0);
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

    // Inside a tunnel there is nothing to see from above, so drop to the chase view until it's out.
    const roofed = world.track.walled[sled.idx] && !world.track.bridge[sled.idx];
    if (this.save.camera === 'top' && !roofed) {
      // Bird's-eye view: high above, looking down, with the direction of travel up the screen.
      const want = sled.yaw;
      if (this.camSnap) this.camYaw = want;
      this.camYaw += wrapAngle(want - this.camYaw) * (1 - Math.exp(-3.5 * dt));
      const fx = Math.sin(this.camYaw);
      const fz = Math.cos(this.camYaw);
      const ratio = clamp(sled.speed / SLED.maxSpeed, 0, 1.3);
      // Climb with speed, so there is more road in view the faster you go.
      const zoom = clamp(this.save.topZoom || 1, 1, 4);
      const height = (29 + ratio * 14) * zoom;
      const y = this.camSnap ? sled.pos.y + height : lerp(cam.position.y, sled.pos.y + height, 1 - Math.exp(-3 * dt));
      // Sit a little behind the sled, so most of the screen shows what's coming.
      const lead = (7 + ratio * 8) * zoom;
      cam.position.set(sled.pos.x + fx * (lead - 4), y, sled.pos.z + fz * (lead - 4));
      cam.up.set(fx, 0, fz);
      cam.lookAt(sled.pos.x + fx * lead, sled.pos.y, sled.pos.z + fz * lead);
      cam.fov = lerp(cam.fov, 52, 1 - Math.exp(-4 * dt));
      cam.updateProjectionMatrix();
      this.camSnap = false;
      return;
    }
    if (this.save.camera === 'high' && !roofed) {
      // High view: well behind and above, looking down the course at an angle, so the hills and the road ahead both show.
      const speed = sled.speed;
      let want = sled.yaw;
      if (speed > 6) want += wrapAngle(Math.atan2(sled.vel.x, sled.vel.z) - sled.yaw) * 0.5;
      if (this.camSnap) this.camYaw = want;
      this.camYaw += wrapAngle(want - this.camYaw) * (1 - Math.exp(-3.5 * dt));
      const fx = Math.sin(this.camYaw);
      const fz = Math.cos(this.camYaw);
      const zoom = clamp(this.save.highZoom || 1, 1, 4);
      const back = 20 * zoom;
      const x = sled.pos.x - fx * back;
      const z = sled.pos.z - fz * back;
      // Stay clear of any hill the camera would otherwise be inside.
      const y = Math.max(sled.pos.y + 13 * zoom, world.ground(x, z, sled.idx) + 4);
      this.camY = this.camSnap ? y : lerp(this.camY, y, 1 - Math.exp(-4 * dt));
      cam.position.set(x, this.camY, z);
      cam.lookAt(sled.pos.x + fx * 16 * zoom, sled.pos.y, sled.pos.z + fz * 16 * zoom);
      cam.fov = lerp(cam.fov, 56, 1 - Math.exp(-4 * dt));
      cam.updateProjectionMatrix();
      this.camSnap = false;
      return;
    }
    if (this.save.camera === 'rider') {
      // Rider's-eye view: from the helmet, looking where the sled points.
      const fx = Math.sin(sled.yaw);
      const fz = Math.cos(sled.yaw);
      cam.position.set(sled.pos.x - fx * 0.3, sled.pos.y + 1.72, sled.pos.z - fz * 0.3);
      const ax = sled.pos.x + fx * 14;
      const az = sled.pos.z + fz * 14;
      const ahead = clamp(world.ground(ax, az, sled.idx) - sled.pos.y, -9, 9);
      this.camTilt = this.camSnap ? ahead : lerp(this.camTilt, ahead, 1 - Math.exp(-6 * dt));
      cam.lookAt(ax, sled.pos.y + 1.4 + this.camTilt * 0.85, az);
      const ratio = clamp(sled.speed / SLED.maxSpeed, 0, 1.3);
      cam.fov = lerp(cam.fov, 72 + ratio * 16, 1 - Math.exp(-4 * dt));
      cam.updateProjectionMatrix();
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

function addHeadlight(sled: Sled, dark = false) {
  // In full darkness the beam has to reach far enough to ride by.
  const light = dark ? new THREE.SpotLight(0xfff0cf, 2600, 190, 0.62, 0.6, 1.35) : new THREE.SpotLight(0xfff0cf, 420, 110, 0.5, 0.7, 1.5);
  light.position.set(0, 1.0, 1.3);
  light.target.position.set(0, 0, 26);
  sled.model.group.add(light, light.target);
  return light;
}

/** Lamps that glow in the dark: a headlamp at the front, a red light at the tail. */
function addLamps(sled: Sled) {
  const front = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff3d0, fog: false }));
  front.position.set(0, 0.8, 1.2);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.1, 0.06), new THREE.MeshBasicMaterial({ color: 0xff2a2a, fog: false }));
  tail.position.set(0, 0.7, -1.32);
  sled.model.group.add(front, tail);
}

const game = new Game();
// Handle for debugging from the browser console.
(window as unknown as { __game: Game }).__game = game;
// The game's building blocks, for scripted test races from the console.
(window as unknown as { __lib: object }).__lib = { World, Race, AIDriver, TRACKS, DIFFICULTIES, SLEDS };
