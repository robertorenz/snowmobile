import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Track, GATE_HEIGHT, GRASS, ROCK, SHALE, ICE } from './track';
import { Terrain, RIVER_DEPTH, RIVER_WATER, CHASM_DEPTH } from './terrain';
import { ALL_SURFACES } from './tracks';
import type { TrackDef, Theme, SurfaceOptions } from './tracks';
import { mulberry32 } from './util';
import { makeNoise } from './noise';
import { Ambient } from './ambient';
import { QUALITY, QualityDef } from './quality';

export interface Collider {
  x: number;
  z: number;
  r: number;
}

const GRID = 8;

/** A car or truck on a highway crossing. */
export interface Vehicle {
  x: number;
  y: number;
  z: number;
  /** Unit direction of the road it drives along. */
  dx: number;
  dz: number;
  halfLength: number;
  height: number;
  mesh: THREE.Object3D;
  /** Road origin, lane offset along the track, speed (signed), and starting offset. */
  ox: number;
  oz: number;
  lane: number;
  speed: number;
  phase: number;
}

/** Something to ride through and collect. */
export interface Pickup {
  kind: 'boost' | 'shield' | 'snowball' | 'repair';
  x: number;
  y: number;
  z: number;
  mesh: THREE.Object3D;
  /** Seconds until it comes back after being taken; 0 while available. */
  respawn: number;
}

/** Half the length of highway that traffic runs along, either side of the track. */
const ROAD_HALF = 92;

/** Spatial hash of solid scenery (trees, rocks) for sled collisions. */
export class ColliderGrid {
  private cells = new Map<number, Collider[]>();

  private key(cx: number, cz: number) {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  add(c: Collider) {
    const k = this.key(Math.floor(c.x / GRID), Math.floor(c.z / GRID));
    const list = this.cells.get(k);
    if (list) list.push(c);
    else this.cells.set(k, [c]);
  }

  /** Calls fn for every collider in the 3x3 cells around a point. */
  near(x: number, z: number, fn: (c: Collider) => void) {
    const cx = Math.floor(x / GRID);
    const cz = Math.floor(z / GRID);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.cells.get(this.key(cx + dx, cz + dz));
        if (list) for (const c of list) fn(c);
      }
    }
  }
}

/** Pool of snow particles kicked up behind the sleds. */
export class SnowSpray {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private next = 0;
  private readonly count = 900;

  constructor() {
    this.pos = new Float32Array(this.count * 3).fill(-1e5);
    this.vel = new Float32Array(this.count * 3);
    this.life = new Float32Array(this.count);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.55,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      map: softDot(),
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = 0.5 + Math.random() * 0.4;
  }

  update(dt: number) {
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const k = i * 3;
      if (this.life[i] <= 0) {
        this.pos[k + 1] = -1e5;
        continue;
      }
      this.vel[k + 1] -= 9 * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

let dotTexture: THREE.Texture | undefined;
export function softDot() {
  if (dotTexture) return dotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  dotTexture = new THREE.CanvasTexture(c);
  return dotTexture;
}

/** Everything that makes up one track's scene: course, terrain, scenery, sky and light. */
export class World {
  readonly scene = new THREE.Scene();
  readonly track: Track;
  readonly terrain: Terrain;
  readonly colliders = new ColliderGrid();
  readonly spray = new SnowSpray();
  readonly theme: Theme;
  private sun: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private skyMat!: THREE.ShaderMaterial;
  private starMat?: THREE.PointsMaterial;
  /** 0 full daylight to 1 night, on tracks where the light fails during the race. */
  darkness = 0;
  private skyGroup = new THREE.Group();
  private snowMat?: THREE.ShaderMaterial;
  private auroraMat?: THREE.ShaderMaterial;
  private time = 0;
  readonly vehicles: Vehicle[] = [];
  /** Clock for the wind in the trees. */
  private wind = { value: 0 };
  readonly pickups: Pickup[] = [];
  /** 0 clear to 1 thick: how heavy the weather is right now. */
  weather = 0;
  private snowSize = 70 * Math.min(window.devicePixelRatio, 2);
  get train() {
    return this.ambient.train;
  }
  /** Deer and anything else alive on the course. */
  get animals() {
    return this.ambient.animals;
  }
  private ambient!: Ambient;

  constructor(
    readonly def: TrackDef,
    readonly surfaces: SurfaceOptions = ALL_SURFACES,
    /** How much scenery to build. The course itself is the same at every level. */
    readonly quality: QualityDef = QUALITY.high,
  ) {
    const theme = (this.theme = def.theme);
    this.track = new Track(def, surfaces);
    this.terrain = new Terrain(this.track, this.quality.plainGround);
    for (let i = 0; i < this.track.n; i++) {
      // Lake ice and full-width ice patches both count as ice for the AI's cornering.
      const sheet = this.track.surface[i] === ICE && this.track.surfSide[i] === 0;
      this.track.ice[i] = sheet || this.terrain.iceAt(this.track.px[i], this.track.pz[i]) > 0.5 ? 1 : 0;
    }
    this.scene.add(this.terrain.mesh);
    this.scene.add(this.spray.points);

    this.scene.fog = new THREE.Fog(theme.fog, theme.fogNear, theme.fogFar);
    this.scene.background = new THREE.Color(theme.fog);

    const hemi = (this.hemi = new THREE.HemisphereLight(theme.ambientSky, theme.ambientGround, theme.ambientIntensity));
    this.scene.add(hemi);

    const sun = (this.sun = new THREE.DirectionalLight(theme.sun, theme.sunIntensity));
    sun.castShadow = this.quality.shadows;
    sun.shadow.mapSize.set(this.quality.shadowSize, this.quality.shadowSize);
    const sc = sun.shadow.camera;
    sc.left = -75;
    sc.right = 75;
    sc.top = 75;
    sc.bottom = -75;
    sc.near = 10;
    sc.far = 420;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    this.scene.add(sun, sun.target);

    this.buildSky();
    this.buildScenery();
    this.ambient = new Ambient(this, this.quality.extras);
  }

  private buildSky() {
    const theme = this.theme;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(5000, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uTop: { value: new THREE.Color(theme.skyTop) },
          uHorizon: { value: new THREE.Color(theme.skyHorizon) },
          uSunDir: { value: new THREE.Vector3(...theme.sunDir).normalize() },
          uSun: { value: new THREE.Color(theme.sun) },
          uSunAmt: { value: theme.night ? 0.5 : theme.fogFar < 500 ? 0.0 : 1.0 },
        },
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 uTop;
          uniform vec3 uHorizon;
          uniform vec3 uSunDir;
          uniform vec3 uSun;
          uniform float uSunAmt;
          varying vec3 vDir;
          void main() {
            vec3 dir = normalize(vDir);
            float h = pow(clamp(dir.y, 0.0, 1.0), 0.55);
            vec3 col = mix(uHorizon, uTop, h);
            float s = max(dot(dir, uSunDir), 0.0);
            col += uSun * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.18) * uSunAmt;
            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    this.skyMat = sky.material as THREE.ShaderMaterial;
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    this.skyGroup.add(sky);

    if (theme.stars || theme.dusk) {
      const n = 1600;
      const p = new Float32Array(n * 3);
      const rnd = mulberry32(99);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const y = 0.06 + rnd() * 0.94;
        const r = Math.sqrt(1 - y * y);
        p[i * 3] = Math.cos(a) * r * 4500;
        p[i * 3 + 1] = y * 4500;
        p[i * 3 + 2] = Math.sin(a) * r * 4500;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      const stars = new THREE.Points(
        g,
        new THREE.PointsMaterial({ color: 0xdcecff, size: 1.8, sizeAttenuation: false, fog: false, depthWrite: false, transparent: true, opacity: theme.dusk ? 0 : 1 }),
      );
      this.starMat = stars.material as THREE.PointsMaterial;
      stars.frustumCulled = false;
      this.skyGroup.add(stars);
    }

    if (theme.aurora) {
      this.auroraMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 } },
        vertexShader: `
          uniform float uTime;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            vec3 p = position;
            p.z += sin(p.x * 0.0022 + uTime * 0.12) * 380.0 + sin(p.x * 0.006 + uTime * 0.2) * 90.0;
            p.y += sin(p.x * 0.004 + uTime * 0.17) * 70.0;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: `
          uniform float uTime;
          varying vec2 vUv;
          void main() {
            float curtain = 0.55 + 0.45 * sin(vUv.x * 90.0 + uTime * 0.5 + sin(vUv.x * 17.0 + uTime * 0.3) * 3.0);
            float a = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.2, 1.0, vUv.y)) * curtain;
            a *= smoothstep(0.0, 0.2, vUv.x) * (1.0 - smoothstep(0.8, 1.0, vUv.x));
            vec3 col = mix(vec3(0.15, 1.0, 0.55), vec3(0.1, 0.65, 0.95), vUv.y);
            gl_FragColor = vec4(col * a * 0.7, a);
          }`,
      });
      for (let i = 0; i < 3; i++) {
        const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(5200, 900, 96, 1), this.auroraMat);
        ribbon.position.set(0, 1300 + i * 250, -3000 + i * 200);
        const pivot = new THREE.Group();
        pivot.rotation.y = -0.5 + i * 1.3;
        pivot.add(ribbon);
        ribbon.frustumCulled = false;
        this.skyGroup.add(pivot);
      }
    }
    this.scene.add(this.skyGroup);

    // Falling snow, wrapped into a box that follows the camera.
    const count = Math.round(theme.snowfall * this.quality.snow);
    if (count > 0) {
      const p = new Float32Array(count * 3);
      const seed = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        p[i * 3] = Math.random() * 90;
        p[i * 3 + 1] = Math.random() * 50;
        p[i * 3 + 2] = Math.random() * 90;
        seed[i] = Math.random();
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
      this.snowMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: { value: 0 },
          uCam: { value: new THREE.Vector3() },
          uWind: { value: new THREE.Vector3(...theme.wind) },
          uSize: { value: 70 * Math.min(window.devicePixelRatio, 2) },
          uAlpha: { value: theme.night ? 0.6 : 0.85 },
        },
        vertexShader: `
          uniform float uTime;
          uniform vec3 uCam;
          uniform vec3 uWind;
          uniform float uSize;
          attribute float seed;
          void main() {
            vec3 box = vec3(90.0, 50.0, 90.0);
            vec3 p = position + uWind * uTime * (0.7 + 0.6 * seed);
            p.x += sin(uTime * 0.8 + seed * 40.0) * 0.7;
            p = mod(p - uCam + box * 0.5, box) - box * 0.5 + uCam;
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = uSize * (0.5 + 0.9 * seed) / max(-mv.z, 1.0);
          }`,
        fragmentShader: `
          uniform float uAlpha;
          void main() {
            float d = length(gl_PointCoord - 0.5);
            float a = smoothstep(0.5, 0.15, d) * uAlpha;
            gl_FragColor = vec4(1.0, 1.0, 1.0, a);
          }`,
      });
      const snow = new THREE.Points(g, this.snowMat);
      snow.frustumCulled = false;
      this.scene.add(snow);
    }
  }

  private buildScenery() {
    const { track, terrain, def, theme } = this;
    const rnd = mulberry32(def.seed * 7919);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const v = new THREE.Vector3();
    const yAxis = new THREE.Vector3(0, 1, 0);

    // Keep trees clear of the waterfalls so they can be seen.
    const falls = (def.waterfalls ?? []).map((w) => {
      const i = track.wrap(Math.round(w.at * track.n));
      const off = w.side * (track.hw[i] + w.gap);
      return [track.px[i] + track.lx[i] * off, track.pz[i] + track.lz[i] * off];
    });
    // ...and out from under bridges and off tunnel roofs.
    const built: number[] = [];
    for (const [a, b] of [...track.bridgeSpans, ...track.tunnelSpans]) for (let i = a; i <= b; i += 3) built.push(i);
    const nearFall = (x: number, z: number) =>
      falls.some(([fx, fz]) => Math.hypot(x - fx, z - fz) < 17) ||
      built.some((i) => Math.hypot(x - track.px[i], z - track.pz[i]) < track.hw[i] + 6);

    // --- Trees: several species, each instance its own size, lean and shade ---
    const detail = this.quality;
    const treeCount = Math.round(def.trees * detail.trees);
    const species = detail.simpleTrees ? makeSimpleTrees(!theme.meadow) : makeTreeSpecies(!theme.meadow, !!theme.meadow, def.seed);
    const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true, side: THREE.DoubleSide });
    // The tops sway a little in the wind; the trunks stay put.
    treeMat.onBeforeCompile = (shader) => {
      shader.uniforms.uWind = this.wind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uWind;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            float gust = sin(uWind * 1.4 + instanceMatrix[3].x * 0.21 + instanceMatrix[3].z * 0.17);
            transformed.x += gust * 0.0035 * position.y * position.y;
            transformed.z += cos(uWind * 1.1 + instanceMatrix[3].x * 0.13) * 0.0022 * position.y * position.y;
          #endif`,
        );
    };
    const planted = species.map(() => [] as THREE.Matrix4[]);
    // Trees proper come first in the list; undergrowth (bushes, stumps, fallen logs) after.
    const firstLow = species.findIndex((sp) => sp.low);
    const tall = firstLow < 0 ? species.length : firstLow;
    const lean = new THREE.Euler();
    let placed = 0;
    let tries = 0;
    while (placed < treeCount && tries < treeCount * 40) {
      tries++;
      const x = terrain.minX + rnd() * terrain.sizeX;
      const z = terrain.minZ + rnd() * terrain.sizeZ;
      const d = terrain.edgeAt(x, z);
      if (d < 3.5 || terrain.wetAt(x, z) > 0.02 || terrain.iceAt(x, z) > 0.02 || this.onRoad(x, z) || nearFall(x, z)) continue;
      // Dense forest lining the course, thinning out up the slopes.
      const keep = d < 45 ? 0.9 : d < 118 ? 0.35 : 0.05;
      if (rnd() > keep) continue;
      terrain.normal(x, z, v);
      if (v.y < 0.78) continue;
      // Pick a species by its share of the forest.
      let pick = rnd();
      let kind = 0;
      while (kind < tall - 1 && pick > species[kind].share) pick -= species[kind++].share;
      const scale = 0.9 + rnd() * 1.15;
      // No tree grows dead straight.
      q.setFromEuler(lean.set((rnd() - 0.5) * 0.12, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.12));
      s.set(scale * (0.85 + rnd() * 0.3), scale * (0.85 + rnd() * 0.4), scale * (0.85 + rnd() * 0.3));
      v.set(x, terrain.height(x, z) - 0.2, z);
      planted[kind].push(new THREE.Matrix4().compose(v, q, s));
      placed++;
      if (d < 60) this.colliders.add({ x, z, r: 0.35 * scale });
    }
    // Undergrowth: thick along the edge of the course, thinning into the forest. Nothing to crash into.
    let low = 0;
    tries = 0;
    const lowWanted = firstLow < 0 ? 0 : Math.round(def.trees * 0.45 * detail.undergrowth);
    while (low < lowWanted && tries++ < lowWanted * 30) {
      const x = terrain.minX + rnd() * terrain.sizeX;
      const z = terrain.minZ + rnd() * terrain.sizeZ;
      const d = terrain.edgeAt(x, z);
      if (d < 2.2 || d > 70 || (d > 22 && rnd() < 0.7) || terrain.wetAt(x, z) > 0.02 || terrain.iceAt(x, z) > 0.02 || this.onRoad(x, z) || nearFall(x, z)) continue;
      terrain.normal(x, z, v);
      if (v.y < 0.8) continue;
      let pick = rnd();
      let kind = tall;
      while (kind < species.length - 1 && pick > species[kind].share) pick -= species[kind++].share;
      const scale = 0.7 + rnd() * 0.9;
      q.setFromEuler(lean.set(0, rnd() * Math.PI * 2, 0));
      s.set(scale, scale * (0.8 + rnd() * 0.4), scale);
      v.set(x, terrain.height(x, z) - 0.05, z);
      planted[kind].push(new THREE.Matrix4().compose(v, q, s));
      low++;
    }
    const shade = new THREE.Color();
    species.forEach((sp, k) => {
      if (!planted[k].length) return;
      const trees = new THREE.InstancedMesh(sp.geo, treeMat, planted[k].length);
      planted[k].forEach((mat, j) => {
        trees.setMatrixAt(j, mat);
        // Lighter or darker, a touch warmer or cooler, but always a green: red and blue never exceed it.
        // Undergrowth keeps its own colours: a green cast would spoil snow and berries.
        const g = sp.low ? 1 : 0.84 + rnd() * 0.3;
        trees.setColorAt(j, sp.low ? shade.setRGB(1, 1, 1) : shade.setRGB(g * (0.9 + rnd() * 0.1), g, g * (0.88 + rnd() * 0.1)));
      });
      trees.castShadow = true;
      trees.receiveShadow = true;
      trees.frustumCulled = false;
      this.scene.add(trees);
    });
    // --- Rocks ---
    const rockCount = Math.round(160 * detail.rocks);
    const rocks = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: 0x6b727b, roughness: 0.95, flatShading: true }),
      rockCount,
    );
    placed = 0;
    tries = 0;
    while (placed < rockCount && tries < rockCount * 60) {
      tries++;
      const x = terrain.minX + rnd() * terrain.sizeX;
      const z = terrain.minZ + rnd() * terrain.sizeZ;
      const d = terrain.edgeAt(x, z);
      if (d < 6 || d > 108 || terrain.wetAt(x, z) > 0.02 || terrain.iceAt(x, z) > 0.02) continue;
      const scale = 0.8 + rnd() * 2.2;
      q.setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3));
      s.set(scale * (0.8 + rnd() * 0.6), scale * (0.5 + rnd() * 0.4), scale * (0.8 + rnd() * 0.6));
      v.set(x, terrain.height(x, z) + scale * 0.1, z);
      rocks.setMatrixAt(placed++, m.compose(v, q, s));
      this.colliders.add({ x, z, r: scale * 0.85 });
    }
    rocks.count = placed;
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    rocks.frustumCulled = false;
    this.scene.add(rocks);

    // --- Marker poles along both edges ---
    const step = Math.max(1, Math.round(22 / track.ds));
    const poleCount = Math.ceil(track.n / step) * 2;
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.07, 2.2, 6);
    poleGeo.translate(0, 1.1, 0);
    const poles = new THREE.InstancedMesh(
      poleGeo,
      new THREE.MeshStandardMaterial({
        roughness: 0.5,
        emissive: 0xffffff,
        emissiveIntensity: theme.night ? 0.9 : 0.25,
      }),
      poleCount,
    );
    const blue = new THREE.Color(0x1d6fd1);
    const red = new THREE.Color(0xd8343a);
    // Emissive tint follows the instance colour so poles read in fog and at night.
    (poles.material as THREE.MeshStandardMaterial).onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance *= diffuseColor.rgb;`,
      );
    };
    placed = 0;
    q.identity();
    s.set(1, 1, 1);
    for (let i = 0; i < track.n; i += step) {
      if (track.walled[i]) continue;
      for (const side of [1, -1]) {
        const x = track.px[i] + track.lx[i] * side * (track.hw[i] + 0.4);
        const z = track.pz[i] + track.lz[i] * side * (track.hw[i] + 0.4);
        v.set(x, terrain.height(x, z), z);
        poles.setMatrixAt(placed, m.compose(v, q, s));
        poles.setColorAt(placed, side > 0 ? blue : red);
        placed++;
      }
    }
    poles.count = placed;
    poles.frustumCulled = false;
    this.scene.add(poles);

    // --- Rock outcrops beside the course ---
    const rockGeos = [1, 2, 3].map((k) => makeRockGeometry(def.seed * 10 + k, !theme.meadow, theme.meadow ? 0x978e7e : 0x636a73));
    const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
    const cragCount = Math.round((def.crags ?? 60) * detail.rocks);
    const perGeo = rockGeos.map(() => [] as THREE.Matrix4[]);
    tries = 0;
    let made = 0;
    while (made < cragCount && tries++ < cragCount * 60) {
      const cx = terrain.minX + rnd() * terrain.sizeX;
      const cz = terrain.minZ + rnd() * terrain.sizeZ;
      const d = terrain.edgeAt(cx, cz);
      // Most stand close enough to the course to loom over it.
      if (d < 5 || d > 95 || (d > 40 && rnd() < 0.6)) continue;
      // Each outcrop is a tight cluster: one big rock with smaller ones against it.
      const big = 3 + rnd() * 5.5;
      const parts = 2 + Math.floor(rnd() * 3);
      for (let k = 0; k < parts; k++) {
        const size = k === 0 ? big : big * (0.35 + rnd() * 0.35);
        const a = rnd() * Math.PI * 2;
        const x = cx + (k === 0 ? 0 : Math.cos(a) * big * 0.9);
        const z = cz + (k === 0 ? 0 : Math.sin(a) * big * 0.9);
        if (nearFall(x, z) || terrain.edgeAt(x, z) < size * 0.9 + 1.5 || terrain.wetAt(x, z) > 0.02 || terrain.iceAt(x, z) > 0.02 || this.onRoad(x, z)) continue;
        q.setFromAxisAngle(yAxis, rnd() * Math.PI * 2);
        // Some are squat boulders, some tall spires.
        s.set(size, size * (0.7 + rnd() * rnd() * 2.2), size * (0.75 + rnd() * 0.5));
        v.set(x, terrain.height(x, z) + s.y * 0.3, z);
        perGeo[Math.floor(rnd() * rockGeos.length)].push(new THREE.Matrix4().compose(v, q, s));
        if (terrain.edgeAt(x, z) < 50) this.colliders.add({ x, z, r: size * 0.8 });
      }
      made++;
    }
    rockGeos.forEach((geo, k) => {
      const mesh = new THREE.InstancedMesh(geo, rockMat, Math.max(1, perGeo[k].length));
      perGeo[k].forEach((mat, j) => mesh.setMatrixAt(j, mat));
      mesh.count = perGeo[k].length;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    });

    // --- Obstacles on the racing surface ---
    if (track.obstacles.length) {
      const stripes = stripeTexture();
      const barrierMat = new THREE.MeshStandardMaterial({
        map: stripes,
        roughness: 0.7,
        emissive: 0xffffff,
        emissiveMap: stripes,
        emissiveIntensity: theme.night ? 0.7 : 0.25,
      });
      const iceMat = new THREE.MeshStandardMaterial({ color: 0x3f86c4, roughness: 0.3, flatShading: true });
      const barkMat = new THREE.MeshStandardMaterial({ color: 0x4a3526, roughness: 0.95 });
      const capMat = new THREE.MeshStandardMaterial({ color: theme.snowTint, roughness: 0.9 });
      const barrierGeo = new THREE.BoxGeometry(2.5, 1.1, 0.55);
      const boulderGeo = new THREE.DodecahedronGeometry(1, 0);
      const logGeo = new THREE.CylinderGeometry(0.42, 0.5, 5.4, 9).rotateZ(Math.PI / 2);
      const stubGeo = new THREE.CylinderGeometry(0.07, 0.11, 1.1, 5);
      const place = (mesh: THREE.Object3D) => {
        mesh.traverse((m) => {
          m.castShadow = true;
          m.receiveShadow = true;
        });
        this.scene.add(mesh);
      };
      for (const o of track.obstacles) {
        const y = terrain.height(o.x, o.z);
        if (o.kind === 'log') {
          // A fallen trunk lying across part of the course, with a few broken branch stubs.
          const log = new THREE.Group();
          log.add(new THREE.Mesh(logGeo, barkMat));
          if (!theme.meadow) {
            const cap = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.14, 0.5), capMat);
            cap.position.y = 0.42;
            log.add(cap);
          }
          for (const bx of [-1.7, -0.4, 1.2, 2.1]) {
            const stub = new THREE.Mesh(stubGeo, barkMat);
            stub.position.set(bx, 0.6, (bx * 7.3) % 0.3);
            stub.rotation.set(((bx * 3.1) % 0.9) - 0.4, 0, ((bx * 5.7) % 0.8) - 0.4);
            log.add(stub);
          }
          const yaw = track.yawAt(o.idx) + o.angle;
          log.position.set(o.x, y + 0.42, o.z);
          // The trunk is built along X; turn it so it lies at o.angle to the direction of travel.
          log.rotation.y = yaw - Math.PI / 2;
          place(log);
          const ax = Math.sin(yaw);
          const az = Math.cos(yaw);
          for (const k of [-2.1, -0.7, 0.7, 2.1]) this.colliders.add({ x: o.x + ax * k, z: o.z + az * k, r: 0.75 });
          continue;
        }
        let mesh: THREE.Mesh;
        if (o.kind === 'barrier') {
          mesh = new THREE.Mesh(barrierGeo, barrierMat);
          mesh.position.set(o.x, y + 0.55, o.z);
          mesh.rotation.y = track.yawAt(o.idx);
        } else if (o.kind === 'rock') {
          mesh = new THREE.Mesh(rockGeos[o.idx % rockGeos.length], rockMat);
          mesh.position.set(o.x, y + o.radius * 0.3, o.z);
          mesh.scale.set(o.radius, o.radius * 0.95, o.radius);
          mesh.rotation.y = o.idx * 1.7;
        } else {
          mesh = new THREE.Mesh(boulderGeo, iceMat);
          mesh.position.set(o.x, y + o.radius * 0.35, o.z);
          mesh.scale.set(o.radius, o.radius * 0.8, o.radius);
          mesh.rotation.y = o.idx;
        }
        place(mesh);
        this.colliders.add({ x: o.x, z: o.z, r: o.kind === 'rock' ? o.radius * 0.9 : o.radius });
      }
    }

    // --- Grass tufts and loose stones standing up out of the surface patches (ride straight through them) ---
    const tufts: THREE.Matrix4[] = [];
    const stones: THREE.Matrix4[] = [];
    for (let i = 0; i < track.n; i++) {
      const type = track.surface[i];
      if ((type !== GRASS && type !== ROCK && type !== SHALE) || track.surfFade[i] < 0.5) continue;
      const per = type === GRASS ? 16 : type === ROCK ? 2 : 1;
      for (let k = 0; k < per; k++) {
        const side = track.surfSide[i];
        const reach = track.hw[i] - 0.6;
        const lat = side === 0 ? (rnd() * 2 - 1) * reach : side * rnd() * reach;
        const x = track.px[i] + track.lx[i] * lat + track.tx[i] * (rnd() - 0.5) * track.ds;
        const z = track.pz[i] + track.lz[i] * lat + track.tz[i] * (rnd() - 0.5) * track.ds;
        q.setFromAxisAngle(yAxis, rnd() * Math.PI * 2);
        if (type === GRASS) {
          const size = 0.4 + rnd() * rnd() * 1.0;
          s.set(size, size * (0.7 + rnd() * 0.7), size);
          v.set(x, terrain.height(x, z) - 0.02, z);
          tufts.push(new THREE.Matrix4().compose(v, q, s));
        } else {
          const size = type === ROCK ? 0.16 + rnd() * 0.22 : 0.08 + rnd() * 0.1;
          s.set(size * (1 + rnd()), size * 0.6, size * (1 + rnd()));
          v.set(x, terrain.height(x, z) + size * 0.1, z);
          stones.push(new THREE.Matrix4().compose(v, q, s));
        }
      }
    }
    const tint = new THREE.Color();
    const litter = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[], vary = false) => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((mat4, j) => {
        mesh.setMatrixAt(j, mat4);
        // Each clump its own shade, from fresh green to winter-dry straw.
        if (vary) mesh.setColorAt(j, tint.setHSL(0.17 + rnd() * 0.13, 0.35 + rnd() * 0.3, 0.42 + rnd() * 0.16));
      });
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    };
    litter(makeGrassClump(def.seed), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }), tufts, true);
    litter(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x5a5b5e, roughness: 0.95, flatShading: true }), stones);

    // --- Waterfalls ---
    for (const w of def.waterfalls ?? []) {
      const i = track.wrap(Math.round(w.at * track.n));
      const off = w.side * (track.hw[i] + w.gap);
      const x = track.px[i] + track.lx[i] * off;
      const z = track.pz[i] + track.lz[i] * off;
      const downstream = w.facing === 'downstream';
      // Face along the track to feed a river, otherwise toward the course.
      const face = downstream ? track.yawAt(i) : Math.atan2(-w.side * track.lx[i], -w.side * track.lz[i]);
      const height = 15 + rnd() * 6;
      const fall = new THREE.Group();
      fall.position.set(x, terrain.height(x, z) - 0.8, z);
      fall.rotation.y = face;
      // A wall of rock, lower and set back in the middle where the water comes over.
      for (let k = -2; k <= 2; k++) {
        const rock = new THREE.Mesh(rockGeos[(k + 2) % rockGeos.length], rockMat);
        const hgt = height * (k === 0 ? 0.52 : 0.6 + rnd() * 0.25);
        rock.scale.set(3.4 + rnd(), hgt, 3.2 + rnd());
        rock.position.set(k * 3.3, hgt * 0.75, k === 0 ? -2.6 : -0.6 - Math.abs(k) * 0.5);
        rock.rotation.y = rnd() * 6;
        rock.castShadow = true;
        rock.receiveShadow = true;
        fall.add(rock);
      }
      const water = new THREE.Mesh(new THREE.PlaneGeometry(4.2, height * 1.02, 1, 12), this.fallMaterial());
      water.position.set(0, height * 0.5, 0.9);
      water.rotation.x = -0.06;
      fall.add(water);
      if (!downstream) {
        const pool = new THREE.Mesh(
          new THREE.CircleGeometry(5.5, 20).rotateX(-Math.PI / 2),
          new THREE.MeshStandardMaterial({ color: theme.meadow ? 0x2f7fb0 : 0x24597e, roughness: 0.12, metalness: 0.35 }),
        );
        pool.position.set(0, 1.0, 4.2);
        fall.add(pool);
      }
      // Spray hanging where the water lands.
      const mistPts: number[] = [];
      for (let k = 0; k < 26; k++) mistPts.push((rnd() - 0.5) * 6, 0.6 + rnd() * 3.2, 1 + rnd() * 3.5);
      const mistGeo = new THREE.BufferGeometry();
      mistGeo.setAttribute('position', new THREE.Float32BufferAttribute(mistPts, 3));
      const mist = new THREE.Points(
        mistGeo,
        new THREE.PointsMaterial({ color: 0xffffff, size: 3.4, map: softDot(), transparent: true, opacity: 0.28, depthWrite: false }),
      );
      fall.add(mist);
      this.scene.add(fall);
      this.colliders.add({ x, z, r: 6.5 });
    }

    // --- River water: a ribbon riding just below the banks ---
    const river = def.river;
    if (river) {
      const pts: number[] = [];
      const idxs: number[] = [];
      const half = river.width / 2 + 7;
      const a = Math.floor(river.from * track.n);
      const b = Math.min(track.n - 1, Math.ceil(river.to * track.n));
      for (let i = a; i <= b; i++) {
        const off = river.side * (track.hw[i] + river.gap);
        const y = track.py[i] - RIVER_DEPTH + RIVER_WATER;
        for (const e of [off - half, off + half]) {
          pts.push(track.px[i] + track.lx[i] * e, y, track.pz[i] + track.lz[i] * e);
        }
        if (i > a) {
          const k = (i - a) * 2;
          idxs.push(k - 2, k, k - 1, k - 1, k, k + 1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      geo.setIndex(idxs);
      geo.computeVertexNormals();
      const water = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: theme.meadow ? 0x2f7fb0 : 0x24597e,
          roughness: 0.12,
          metalness: 0.35,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
        }),
      );
      water.receiveShadow = true;
      this.scene.add(water);
    }

    this.buildStructures();
    this.buildCrossings();
    this.buildPickups();

    // --- Start / finish gates ---
    this.scene.add(this.makeGate(track.startIdx, track.closed ? 'START / FINISH' : 'START'));
    if (!track.closed) this.scene.add(this.makeGate(track.finishIdx, 'FINISH'));

    // --- Distant peaks ---
    if (theme.fogFar > 600) {
      const cx = terrain.minX + terrain.sizeX / 2;
      const cz = terrain.minZ + terrain.sizeZ / 2;
      const rx = terrain.sizeX / 2 + 500;
      const rz = terrain.sizeZ / 2 + 500;
      const peakColor = new THREE.Color(theme.snowTint).lerp(new THREE.Color(theme.fog), 0.55);
      const peakMat = new THREE.MeshLambertMaterial({ color: peakColor, flatShading: true, fog: false });
      const count = 46;
      const peaks = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7, 3), peakMat, count);
      const jag = peaks.geometry.attributes.position;
      for (let i = 0; i < jag.count; i++) {
        if (jag.getY(i) < 0.49) {
          jag.setX(i, jag.getX(i) * (0.8 + rnd() * 0.5));
          jag.setZ(i, jag.getZ(i) * (0.8 + rnd() * 0.5));
        }
      }
      peaks.geometry.computeVertexNormals();
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + rnd() * 0.1;
        const out = 1 + rnd() * 0.5;
        const x = cx + Math.cos(a) * rx * out;
        const z = cz + Math.sin(a) * rz * out;
        const h = 320 + rnd() * 420;
        const base = terrain.height(x, z) - 80;
        q.setFromAxisAngle(yAxis, rnd() * 6);
        s.set(260 + rnd() * 260, h, 260 + rnd() * 260);
        v.set(x, base + h / 2, z);
        peaks.setMatrixAt(i, m.compose(v, q, s));
      }
      peaks.frustumCulled = false;
      this.scene.add(peaks);
    }
  }

  private makeGate(idx: number, label: string) {
    const { track, terrain } = this;
    const hw = track.hw[idx];
    const gate = new THREE.Group();
    const span = hw * 2 + 4;
    const postMat = new THREE.MeshStandardMaterial({ color: 0x18344f, roughness: 0.6, metalness: 0.3 });
    for (const side of [1, -1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 8, 0.6), postMat);
      post.position.set((side * span) / 2, 4, 0);
      post.castShadow = true;
      gate.add(post);
    }
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 96;
    const g = c.getContext('2d')!;
    g.fillStyle = '#0e2033';
    g.fillRect(0, 0, c.width, c.height);
    for (let x = 0; x < c.width; x += 24) {
      for (let y = 0; y < 2; y++) {
        g.fillStyle = (x / 24 + y) % 2 ? '#f3f8fc' : '#0b1622';
        g.fillRect(x, y * 12, 24, 12);
        g.fillRect(x, c.height - 24 + y * 12, 24, 12);
      }
    }
    g.fillStyle = '#f6a821';
    g.font = 'italic 900 44px "Segoe UI", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, c.width / 2, c.height / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const faceMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35 });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 0.6, span * 0.094, 0.5), [
      postMat,
      postMat,
      postMat,
      postMat,
      faceMat,
      faceMat,
    ]);
    beam.position.y = 7.4;
    beam.castShadow = true;
    gate.add(beam);

    gate.position.set(track.px[idx], terrain.height(track.px[idx], track.pz[idx]), track.pz[idx]);
    // Local +Z of the beam faces along the track, so racers read the banner head-on.
    gate.rotation.y = track.yawAt(idx) + Math.PI;
    return gate;
  }

  /**
   * Height of whatever a sled at track sample idx is riding on: the bridge
   * deck if it's on a bridge, otherwise the terrain.
   */
  ground(x: number, z: number, idx: number) {
    const t = this.track;
    if (t.bridge[idx]) {
      const rx = x - t.px[idx];
      const rz = z - t.pz[idx];
      if (Math.abs(rx * t.lx[idx] + rz * t.lz[idx]) < t.hw[idx] + 1.5) {
        const along = Math.max(-t.ds, Math.min(t.ds, rx * t.tx[idx] + rz * t.tz[idx]));
        return t.py[idx] + along * t.slope[idx];
      }
    }
    return this.terrain.height(x, z);
  }

  groundNormal(x: number, z: number, idx: number, out: THREE.Vector3) {
    if (!this.track.bridge[idx]) return this.terrain.normal(x, z, out);
    const t = this.track;
    // The deck is flat across and tilted along its length.
    return out.set(-t.tx[idx] * t.slope[idx], 1, -t.tz[idx] * t.slope[idx]).normalize();
  }

  private fallMat?: THREE.ShaderMaterial;

  /** Falling water: streaks sliding down a white-blue sheet. One material, shared by every waterfall. */
  private fallMaterial() {
    this.fallMat ??= new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          float strand = sin(vUv.x * 46.0 + sin(vUv.y * 7.0 - uTime * 3.0) * 1.8) * 0.5 + 0.5;
          float streak = fract(vUv.y * 3.0 + uTime * 0.85 + sin(vUv.x * 23.0) * 0.35);
          float foam = smoothstep(0.25, 0.0, vUv.y);
          vec3 col = mix(vec3(0.5, 0.74, 0.9), vec3(1.0), clamp(strand * 0.55 + streak * 0.35 + foam, 0.0, 1.0));
          float edge = smoothstep(0.0, 0.14, vUv.x) * (1.0 - smoothstep(0.86, 1.0, vUv.x));
          gl_FragColor = vec4(col, edge * (0.72 + 0.28 * streak));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    return this.fallMat;
  }

  /** True on a highway's tarmac, where nothing should be planted. */
  private onRoad(x: number, z: number) {
    const track = this.track;
    for (const c of track.crossings) {
      if (c.kind !== 'highway') continue;
      const rx = x - track.px[c.idx];
      const rz = z - track.pz[c.idx];
      const along = rx * track.tx[c.idx] + rz * track.tz[c.idx];
      const across = rx * track.lx[c.idx] + rz * track.lz[c.idx];
      if (Math.abs(along) < c.half + 5 && Math.abs(across) < ROAD_HALF + 10) return true;
    }
    return false;
  }

  /** Boost canisters, shields and snowballs floating over the road, one every 230 m or so. */
  private buildPickups() {
    const { track, def } = this;
    const rnd = mulberry32(def.seed * 613 + 1);
    const glow = (color: number) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7, roughness: 0.35, metalness: 0.3 });
    const make: Record<Pickup['kind'], () => THREE.Object3D> = {
      boost: () => new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.0, 12), glow(0xf6a821)),
      shield: () => new THREE.Mesh(new THREE.OctahedronGeometry(0.62), glow(0x1ea7e1)),
      snowball: () => new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), glow(0xe9f2f8)),
      repair: () => new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), glow(0x2fbf71)),
    };
    const kinds: Pickup['kind'][] = ['boost', 'snowball', 'repair', 'shield', 'boost', 'snowball', 'repair'];
    const from = track.startS + 150;
    const to = (track.closed ? track.length : track.finishIdx * track.ds) - 60;
    let k = Math.floor(rnd() * kinds.length);
    for (let s = from + rnd() * 80; s < to; s += 200 + rnd() * 70) {
      const i = track.wrap(Math.round(s / track.ds));
      // Not in the middle of a jump or its landing, and not on a highway.
      if (track.respawn[i] !== i || track.asphalt[i]) continue;
      const lat = (rnd() * 2 - 1) * (track.hw[i] - 2) * 0.6;
      const x = track.px[i] + track.lx[i] * lat;
      const z = track.pz[i] + track.lz[i] * lat;
      const kind = kinds[k++ % kinds.length];
      const mesh = make[kind]();
      mesh.scale.setScalar(1.35);
      const y = this.ground(x, z, i) + 1.15;
      mesh.position.set(x, y, z);
      this.scene.add(mesh);
      this.pickups.push({ kind, x, y, z, mesh, respawn: 0 });
    }
  }

  /** Bridges where the course crosses over itself, and tunnels. */
  private buildStructures() {
    const { track, terrain, theme } = this;
    const steel = new THREE.MeshStandardMaterial({ color: 0x33404d, roughness: 0.6, metalness: 0.5, side: THREE.DoubleSide });
    const deckMat = new THREE.MeshStandardMaterial({ color: theme.trackTint, roughness: 0.9 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0xd8343a, roughness: 0.6 });
    /** A strip of quads between two polylines. */
    const strip = (a: number[], b: number[], mat: THREE.Material) => {
      const idx: number[] = [];
      const n = a.length / 3;
      for (let k = 0; k < n - 1; k++) idx.push(k, n + k, k + 1, k + 1, n + k, n + k + 1);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b], 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    };
    /** Points along a span, offset sideways and vertically from the centerline. */
    const line = (a: number, b: number, side: number, dy: number) => {
      const out: number[] = [];
      for (let i = a; i <= b; i++) {
        out.push(track.px[i] + track.lx[i] * side * track.hw[i], track.py[i] + dy, track.pz[i] + track.lz[i] * side * track.hw[i]);
      }
      return out;
    };

    for (const [a, b] of track.bridgeSpans) {
      // Deck, underside, girders and guard rails.
      strip(line(a, b, 1, 0.02), line(a, b, -1, 0.02), deckMat);
      strip(line(a, b, -1, -1.3), line(a, b, 1, -1.3), steel);
      for (const side of [1, -1]) {
        strip(line(a, b, side, -1.3), line(a, b, side, 1.0), steel);
        strip(line(a, b, side * 1.02, 0.95), line(a, b, side * 1.02, 1.2), railMat);
      }
      // Piers down to the ground, except where the road below runs.
      const pierGeo = new THREE.CylinderGeometry(0.55, 0.7, 1, 8);
      for (let i = a; i <= b; i += 7) {
        for (const side of [1, -1]) {
          const x = track.px[i] + track.lx[i] * side * (track.hw[i] - 0.8);
          const z = track.pz[i] + track.lz[i] * side * (track.hw[i] - 0.8);
          if (terrain.edgeAt(x, z) < 2.5) continue;
          const base = terrain.height(x, z) - 1;
          const top = track.py[i] - 1.3;
          if (top - base < 1) continue;
          const pier = new THREE.Mesh(pierGeo, steel);
          pier.scale.y = top - base;
          pier.position.set(x, (top + base) / 2, z);
          pier.castShadow = true;
          this.scene.add(pier);
          this.colliders.add({ x, z, r: 0.9 });
        }
      }
    }

    const rockOut = new THREE.MeshStandardMaterial({ color: theme.meadow ? 0x8a8273 : 0x59606a, roughness: 0.95, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c2229, roughness: 0.9, side: THREE.BackSide });
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffc56b, emissiveIntensity: 3 });
    for (const [a, b] of track.tunnelSpans) {
      // A vaulted tube: rings of points from one wall, over the roof, to the other.
      const K = 10;
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = a; i <= b; i++) {
        const r = track.hw[i] + 0.9;
        for (let k = 0; k <= K; k++) {
          const ang = (k / K) * Math.PI;
          const side = Math.cos(ang) * r;
          pos.push(track.px[i] + track.lx[i] * side, track.py[i] - 0.5 + Math.sin(ang) * r * 0.82 + 0.5, track.pz[i] + track.lz[i] * side);
        }
        if (i > a) {
          const row = (i - a) * (K + 1);
          for (let k = 0; k < K; k++) {
            const p = row + k;
            const q = p - (K + 1);
            idx.push(q, p, q + 1, q + 1, p, p + 1);
          }
        }
        // A lamp on the roof every so often.
        if ((i - a) % 6 === 3) {
          const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.3), lampMat);
          lamp.position.set(track.px[i], track.py[i] + r * 0.82 - 0.15, track.pz[i]);
          lamp.rotation.y = track.yawAt(i);
          this.scene.add(lamp);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const shell = new THREE.Mesh(geo, rockOut);
      shell.castShadow = true;
      // The same shell seen from inside is dark.
      this.scene.add(shell, new THREE.Mesh(geo, dark));
      // A heavy stone arch at each mouth.
      for (const i of [a, b]) {
        const r = track.hw[i] + 1.5;
        const arch = new THREE.Mesh(new THREE.TorusGeometry(r, 0.9, 6, 14, Math.PI), rockOut);
        arch.scale.y = 0.82;
        arch.position.set(track.px[i], track.py[i], track.pz[i]);
        arch.rotation.y = track.yawAt(i);
        arch.castShadow = true;
        this.scene.add(arch);
      }
    }
  }

  /** What riders have to jump: water, a pit, a fence, or a road with traffic on it. */
  private buildCrossings() {
    const { track, terrain, theme } = this;
    const stripes = stripeTexture();
    const signMat = new THREE.MeshStandardMaterial({
      map: stripes,
      emissive: 0xffffff,
      emissiveMap: stripes,
      emissiveIntensity: theme.night ? 0.8 : 0.3,
      roughness: 0.7,
    });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2a3440, roughness: 0.7 });
    const rnd = mulberry32(track.def.seed * 17 + 3);

    for (const c of track.crossings) {
      const i = c.idx;
      const yaw = track.yawAt(i);
      // Local frame: +Z runs along the track, +X to its left, origin on the ground mid-crossing.
      const node = new THREE.Group();
      node.position.set(track.px[i], c.y, track.pz[i]);
      node.rotation.y = yaw;
      this.scene.add(node);

      // Warning boards either side of the ramp's lip.
      const lip = track.wrap(Math.round(c.lipS / track.ds));
      for (const side of [1, -1]) {
        const off = side * (track.hw[lip] + 1.4);
        const x = track.px[lip] + track.lx[lip] * off;
        const z = track.pz[lip] + track.lz[lip] * off;
        const y = terrain.height(x, z);
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3.4, 0.14), postMat);
        post.position.set(x, y + 1.7, z);
        const board = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.9, 0.1), signMat);
        board.position.set(x, y + 3.2, z);
        board.rotation.y = yaw;
        post.castShadow = board.castShadow = true;
        this.scene.add(post, board);
      }

      if (c.kind === 'river') {
        const water = new THREE.Mesh(
          new THREE.PlaneGeometry(190, c.half * 2 + 8).rotateX(-Math.PI / 2),
          new THREE.MeshStandardMaterial({
            color: theme.meadow ? 0x2f7fb0 : 0x24597e,
            roughness: 0.12,
            metalness: 0.35,
            transparent: true,
            opacity: 0.9,
          }),
        );
        water.position.y = -RIVER_DEPTH + RIVER_WATER;
        node.add(water);
      } else if (c.kind === 'chasm') {
        // A black floor, so the pit reads as bottomless.
        const floor = new THREE.Mesh(
          new THREE.PlaneGeometry(190, c.half * 2 + 6).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: 0x04070a, fog: false }),
        );
        floor.position.y = -CHASM_DEPTH + 1.5;
        node.add(floor);
      } else if (c.kind === 'gate') {
        const hw = track.hw[i];
        const wood = new THREE.MeshStandardMaterial({ color: 0x7a5636, roughness: 0.9 });
        const white = new THREE.MeshStandardMaterial({ color: 0xf3f6f8, roughness: 0.7 });
        const red = new THREE.MeshStandardMaterial({ color: 0xd8343a, roughness: 0.7 });
        const span = hw * 2 + 22;
        // Fence running off into the snow either side, and a painted gate across the course.
        for (const h of [0.55, 1.05, GATE_HEIGHT - 0.06]) {
          const rail = new THREE.Mesh(new THREE.BoxGeometry(span, 0.12, 0.1), wood);
          rail.position.y = h;
          rail.castShadow = true;
          node.add(rail);
          const bar = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, 0.16, 0.14), h === 1.05 ? red : white);
          bar.position.y = h;
          bar.castShadow = true;
          node.add(bar);
        }
        for (let x = -span / 2; x <= span / 2 + 0.01; x += span / 14) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, GATE_HEIGHT + 0.3, 0.2), Math.abs(x) < hw ? white : wood);
          post.position.set(x, (GATE_HEIGHT + 0.3) / 2, 0);
          post.castShadow = true;
          node.add(post);
        }
      } else {
        // Highway: tarmac with lane markings, a tunnel mouth at each end, and traffic.
        const rc = document.createElement('canvas');
        rc.width = 128;
        rc.height = 256;
        const g = rc.getContext('2d')!;
        g.fillStyle = '#2b2f34';
        g.fillRect(0, 0, 128, 256);
        g.fillStyle = '#e8e8e2';
        g.fillRect(0, 10, 128, 6);
        g.fillRect(0, 240, 128, 6);
        g.fillStyle = '#e9b93a';
        g.fillRect(16, 124, 72, 8);
        const tex = new THREE.CanvasTexture(rc);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.repeat.set(ROAD_HALF / 4, 1);
        tex.anisotropy = 8;
        const road = new THREE.Mesh(
          new THREE.PlaneGeometry(ROAD_HALF * 2, c.half * 2).rotateX(-Math.PI / 2),
          new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }),
        );
        road.position.y = 0.07;
        road.receiveShadow = true;
        node.add(road);
        const tunnelMat = new THREE.MeshStandardMaterial({ color: 0x1b2026, roughness: 0.9 });
        for (const side of [1, -1]) {
          const mouth = new THREE.Mesh(new THREE.BoxGeometry(10, 7, c.half * 2 + 3), tunnelMat);
          mouth.position.set(side * (ROAD_HALF + 3), 3.5, 0);
          node.add(mouth);
        }

        const colors = [0xc0392b, 0x2471a3, 0xe5e8ea, 0x1e8449, 0xd68910, 0x34495e];
        const count = 6;
        for (let k = 0; k < count; k++) {
          const lane = k % 2 ? 1 : -1;
          const truck = rnd() < 0.35;
          const length = truck ? 7.5 : 4.2;
          const height = truck ? 2.3 : 1.5;
          const mesh = new THREE.Group();
          const bodyMat = new THREE.MeshStandardMaterial({ color: colors[k % colors.length], roughness: 0.4, metalness: 0.3 });
          const body = new THREE.Mesh(new THREE.BoxGeometry(length, height * (truck ? 0.85 : 0.5), 2), bodyMat);
          body.position.y = height * (truck ? 0.55 : 0.4);
          const cabin = new THREE.Mesh(
            new THREE.BoxGeometry(length * (truck ? 0.22 : 0.5), height * 0.45, 1.8),
            new THREE.MeshStandardMaterial({ color: 0x1a222b, roughness: 0.2, metalness: 0.4 }),
          );
          cabin.position.set(truck ? length * 0.36 : -0.2, height * (truck ? 0.5 : 0.78), 0);
          const lights = new THREE.Mesh(
            new THREE.BoxGeometry(0.1, 0.2, 1.6),
            new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c4, emissiveIntensity: 2.5 }),
          );
          lights.position.set(length / 2, height * 0.3, 0);
          body.castShadow = cabin.castShadow = true;
          mesh.add(body, cabin, lights);
          // Meshes are built facing +X; oncoming traffic is turned around.
          mesh.rotation.y = yaw + (lane > 0 ? 0 : Math.PI);
          this.scene.add(mesh);
          this.vehicles.push({
            x: 0,
            y: c.y,
            z: 0,
            dx: track.lx[i],
            dz: track.lz[i],
            halfLength: length / 2,
            height,
            mesh,
            ox: track.px[i],
            oz: track.pz[i],
            // Lane offset is along the track; lane 1 drives toward the track's left.
            lane: lane * c.half * 0.48,
            speed: lane * (13 + rnd() * 7),
            phase: (k / count) * ROAD_HALF * 2 + rnd() * 12,
          });
        }
      }
    }
    this.setRaceTime(0);
  }

  /** Moves highway traffic to where it is at the given race time. */
  setRaceTime(t: number) {
    const span = ROAD_HALF * 2;
    for (const v of this.vehicles) {
      const along = ((((v.phase + t * v.speed) % span) + span) % span) - ROAD_HALF;
      // Tangent of the track at this road = the direction lanes are offset in.
      const tx = -v.dz;
      const tz = v.dx;
      v.x = v.ox + v.dx * along + tx * v.lane;
      v.z = v.oz + v.dz * along + tz * v.lane;
      v.mesh.position.set(v.x, v.y + 0.08, v.z);
    }
  }

  /**
   * Sets how far the day has gone on a dusk track: 0 is the track's own
   * light, 1 is night. Sky, fog, sun and ambient light all slide toward a
   * night palette and the stars come out.
   */
  setDarkness(k: number) {
    if (!this.theme.dusk || Math.abs(k - this.darkness) < 0.004) return;
    this.darkness = k;
    const th = this.theme;
    const mix = (day: number, night: number, into: THREE.Color) => into.setHex(day).lerp(_night.setHex(night), k);
    const u = this.skyMat.uniforms;
    mix(th.skyTop, 0x030814, u.uTop.value);
    mix(th.skyHorizon, 0x10304c, u.uHorizon.value);
    u.uSunAmt.value = 1 - k * 0.8;
    const fog = this.scene.fog as THREE.Fog;
    mix(th.fog, 0x0c2439, fog.color);
    (this.scene.background as THREE.Color).copy(fog.color);
    mix(th.sun, 0xa9c8ff, this.sun.color);
    this.sun.intensity = th.sunIntensity * (1 - 0.62 * k);
    mix(th.ambientSky, 0x3f6fa8, this.hemi.color);
    mix(th.ambientGround, 0x1d3a55, this.hemi.groundColor);
    this.hemi.intensity = th.ambientIntensity * (1 - 0.4 * k);
    if (this.starMat) this.starMat.opacity = Math.max(0, k * 1.6 - 0.6);
  }

  /** Per-frame upkeep: keep sky, snowfall and shadows centred on the action. */
  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3) {
    this.time += dt;
    this.skyGroup.position.copy(camera.position);
    if (this.snowMat) {
      this.snowMat.uniforms.uTime.value = this.time;
      (this.snowMat.uniforms.uCam.value as THREE.Vector3).copy(camera.position);
    }
    if (this.auroraMat) this.auroraMat.uniforms.uTime.value = this.time;
    if (this.fallMat) this.fallMat.uniforms.uTime.value = this.time;
    const d = this.theme.sunDir;
    const l = Math.hypot(d[0], d[1], d[2]);
    this.sun.target.position.copy(focus);
    this.sun.position.set(focus.x + (d[0] / l) * 200, focus.y + (d[1] / l) * 200, focus.z + (d[2] / l) * 200);
    this.spray.update(dt);
    this.ambient.update(dt);
    this.wind.value = this.time;

    // Weather drifts: every few minutes the air thickens and the snow comes down harder, then clears again.
    const fog = this.scene.fog as THREE.Fog;
    if (this.theme.fogFar > 500) {
      const w = 0.5 + 0.5 * Math.sin(this.time * 0.035 + this.def.seed);
      const k = w * w;
      this.weather = k;
      fog.far = this.theme.fogFar * (1 - 0.5 * k);
      fog.near = this.theme.fogNear * (1 - 0.4 * k);
      if (this.snowMat) {
        this.snowMat.uniforms.uAlpha.value = (this.theme.night ? 0.6 : 0.85) * (0.55 + 0.75 * k);
        this.snowMat.uniforms.uSize.value = this.snowSize * (0.8 + 0.8 * k);
      }
    }
    for (const p of this.pickups) {
      p.mesh.visible = p.respawn <= 0;
      p.mesh.rotation.y += dt * 2.2;
      p.mesh.position.y = p.y + Math.sin(this.time * 2.4 + p.x) * 0.15;
    }
  }

  dispose() {
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      for (const one of Array.isArray(mat) ? mat : [mat]) {
        const map = (one as THREE.MeshStandardMaterial).map;
        if (map && map !== dotTexture) map.dispose();
        one.dispose();
      }
    });
  }
}

/**
 * A rough boulder about one unit across, coloured per face: bare rock with
 * darker bands on the sides and (in winter) snow lying on anything that faces up.
 */
function makeRockGeometry(seed: number, snowy: boolean, rockHex: number) {
  const noise = makeNoise(seed);
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    // Displacement depends only on position, so faces that share a corner stay joined.
    const d = 1 + 0.32 * noise.noise2(x * 1.7 + y * 2.3, z * 1.9 - y * 1.1) + 0.14 * noise.noise2(x * 4.1 - z * 3.3, y * 4.7);
    // Flatten the underside so it sits on the ground.
    p.setXYZ(i, x * d, Math.max(y * d, -0.45), z * d);
  }
  geo.computeVertexNormals();
  const n = geo.attributes.normal;
  const rock = new THREE.Color(rockHex);
  const snow = new THREE.Color(0xf1f6fa);
  const c = new Float32Array(p.count * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i < p.count; i += 3) {
    // One colour per triangle, from its facing and height.
    const up = n.getY(i);
    const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const band = 0.78 + 0.22 * Math.sin(y * 6.0 + noise.noise2(p.getX(i) * 2, p.getZ(i) * 2) * 2);
    tmp.copy(rock).multiplyScalar(band);
    if (snowy && up > 0.45) tmp.lerp(snow, Math.min(1, (up - 0.45) * 3.5));
    for (let k = 0; k < 3; k++) {
      c[(i + k) * 3] = tmp.r;
      c[(i + k) * 3 + 1] = tmp.g;
      c[(i + k) * 3 + 2] = tmp.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/**
 * A clump of grass: a dozen thin blades fanning out from one point, each
 * bending over toward its tip. Vertex colours run dark at the root to pale
 * at the tip, and the instance colour tints the whole clump.
 */
function makeGrassClump(seed: number) {
  const rnd = mulberry32(seed * 31 + 9);
  const pos: number[] = [];
  const col: number[] = [];
  const blades = 12;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + rnd() * 0.5;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const h = 0.22 + rnd() * 0.3;
    const lean = 0.08 + rnd() * 0.28;
    const w = 0.022 + rnd() * 0.014;
    // Blade outline: two points at the root, two at the knee, one at the tip.
    const root = 0.03 + rnd() * 0.04;
    const pts = [
      [dx * root - dz * w, 0, dz * root + dx * w],
      [dx * root + dz * w, 0, dz * root - dx * w],
      [dx * (root + lean * 0.35) - dz * w * 0.75, h * 0.6, dz * (root + lean * 0.35) + dx * w * 0.75],
      [dx * (root + lean * 0.35) + dz * w * 0.75, h * 0.6, dz * (root + lean * 0.35) - dx * w * 0.75],
      [dx * (root + lean), h, dz * (root + lean)],
    ];
    for (const k of [0, 1, 2, 1, 3, 2, 2, 3, 4]) {
      pos.push(pts[k][0], pts[k][1], pts[k][2]);
      const up = pts[k][1] / h;
      col.push(0.45 + up * 0.55, 0.5 + up * 0.5, 0.4 + up * 0.45);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

const _night = new THREE.Color();

/** Amber and black hazard stripes. */
function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f6a821';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#14181d';
  for (let x = -64; x < 256; x += 64) {
    g.beginPath();
    g.moveTo(x, 64);
    g.lineTo(x + 32, 64);
    g.lineTo(x + 96, 0);
    g.lineTo(x + 64, 0);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The low-detail forest: one kind of tree, a trunk under three stacked
 * cones, about a fifth of the triangles of a detailed conifer.
 */
function makeSimpleTrees(frosted: boolean): TreeSpecies[] {
  const parts: THREE.BufferGeometry[] = [];
  const paint = (g: THREE.BufferGeometry, fn: (y: number) => THREE.Color) => {
    const p = g.attributes.position;
    const c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) fn(p.getY(i)).toArray(c, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  };
  const bark = new THREE.Color(0x4a3628);
  const trunk = new THREE.CylinderGeometry(0.16, 0.22, 1.4, 5).translate(0, 0.7, 0);
  paint(trunk, () => bark);
  parts.push(trunk);
  const green = new THREE.Color(frosted ? 0x1f4a38 : 0x2c6a3c);
  const frost = new THREE.Color(0xe9f2f8);
  const tmp = new THREE.Color();
  for (const [r, h, y] of [[1.55, 2.3, 1.0], [1.2, 2.0, 2.3], [0.8, 1.8, 3.5]]) {
    const cone = new THREE.ConeGeometry(r, h, 7);
    paint(cone, (py) => tmp.copy(green).lerp(frost, frosted ? Math.pow((py + h / 2) / h, 1.6) * 0.75 : 0));
    cone.translate(0, y + h / 2, 0);
    parts.push(cone);
  }
  return [{ name: 'pine', geo: mergeGeometries(parts)!.toNonIndexed(), share: 1 }];
}

/** One kind of tree, and how much of the forest it makes up. */
interface TreeSpecies {
  name: string;
  /** Undergrowth rather than a tree: planted by its own rules, and not solid. */
  low?: boolean;
  geo: THREE.BufferGeometry;
  share: number;
}

type V3 = [number, number, number];

/**
 * The forest's species, each with its own silhouette:
 *
 * - Spruce: broad and dense, boughs to the ground.
 * - Douglas fir: very tall and narrow, dark, with long drooping boughs.
 * - White pine: a long bare trunk under open, level whorls of branches.
 * - Young fir: a small conifer.
 * - Tamarack (larch): a slim, airy conifer that sheds its needles, so it stands bare in winter.
 * - Elm: a trunk that divides into limbs fanning up and out like a vase.
 * - Birch: slender, with white bark and fine upswept branches.
 *
 * Tamarack, elm and birch are bare with snow on them on winter tracks and in
 * leaf on the meadow tracks.
 */
function makeTreeSpecies(frosted: boolean, meadow: boolean, seed: number): TreeSpecies[] {
  const rnd = mulberry32(seed * 419 + 3);
  const bark = new THREE.Color(0x4a3628);
  const frost = new THREE.Color(0xeaf2f8);
  const noise = makeNoise(seed + 77);

  /** Collects loose triangles with a colour per corner. */
  const mesher = () => {
    const pos: number[] = [];
    const col: number[] = [];
    const tri = (a: number[], b: number[], c: number[], ca: THREE.Color, cb: THREE.Color, cc: THREE.Color) => {
      pos.push(...a, ...b, ...c);
      col.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);
    };
    /** A tapering stick between two points: trunks, limbs and twigs. */
    const stick = (a: V3, b: V3, r0: number, r1: number, c0: THREE.Color, c1: THREE.Color = c0, sides = 4) => {
      const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      const u = new THREE.Vector3(Math.abs(d.y) > 0.9 ? 1 : 0, Math.abs(d.y) > 0.9 ? 0 : 1, 0).cross(d).normalize();
      const w = new THREE.Vector3().crossVectors(d, u);
      const at = (p: V3, r: number, k: number) => {
        const ang = (k / sides) * Math.PI * 2;
        const cx = Math.cos(ang) * r;
        const cy = Math.sin(ang) * r;
        return [p[0] + u.x * cx + w.x * cy, p[1] + u.y * cx + w.y * cy, p[2] + u.z * cx + w.z * cy];
      };
      for (let k = 0; k < sides; k++) {
        const a0 = at(a, r0, k);
        const a1 = at(a, r0, k + 1);
        const b0 = at(b, r1, k);
        const b1 = at(b, r1, k + 1);
        tri(a0, b0, a1, c0, c1, c0);
        tri(a1, b0, b1, c0, c1, c1);
      }
    };
    /** A lumpy ball of foliage. */
    const clump = (c: V3, size: number, squash: number, color: THREE.Color) => {
      const blob = new THREE.IcosahedronGeometry(1, 0);
      const p = blob.attributes.position;
      const shift = rnd() * 9;
      for (let i = 0; i < p.count; i += 3) {
        const pts: number[][] = [];
        for (let j = 0; j < 3; j++) {
          const x = p.getX(i + j);
          const y = p.getY(i + j);
          const z = p.getZ(i + j);
          const d = size * (1 + 0.3 * noise.noise2(x * 2.1 + y * 1.7 + shift, z * 2.3 - y));
          pts.push([c[0] + x * d, c[1] + y * d * squash, c[2] + z * d]);
        }
        // Sunlit on top, shaded underneath.
        const up = ((pts[0][1] + pts[1][1] + pts[2][1]) / 3 - c[1]) / (size * squash);
        const shade = color.clone().multiplyScalar(0.74 + 0.36 * Math.max(-0.4, up) + rnd() * 0.1);
        tri(pts[0], pts[1], pts[2], shade, shade, shade);
      }
    };
    const build = () => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.computeVertexNormals();
      return geo;
    };
    return { tri, stick, clump, build };
  };
  type Mesher = ReturnType<typeof mesher>;

  /**
   * A conifer: tiers of boughs up a tapering trunk. Each tier is a ragged
   * skirt of pointed branches. `overlap` sets how far each tier hangs over
   * the one below (high is dense, low leaves the trunk showing between
   * whorls); `droop` how far the tips hang (negative lifts them).
   */
  const conifer = (o: {
    tiers: number;
    base: number;
    top: number;
    height: number;
    bare: number;
    droop: number;
    green: number;
    overlap?: number;
    boughs?: number;
    trunk?: number;
    snow?: number;
  }) => {
    const m = mesher();
    const green = new THREE.Color(o.green);
    const deep = green.clone().multiplyScalar(0.55);
    const snow = o.snow ?? 1;
    // Where snow lies: heavy near the trunk on each bough, thin at the tips.
    const crest = frosted ? green.clone().lerp(frost, 0.72 * snow) : green.clone().multiplyScalar(1.25);
    const mid = frosted ? green.clone().lerp(frost, 0.26 * snow) : green.clone().multiplyScalar(1.08);
    const tip = frosted ? green.clone().lerp(frost, 0.04) : green.clone();
    m.stick([0, 0, 0], [0, o.height * 0.96, 0], o.trunk ?? 0.2, 0.03, bark, bark, 6);
    const span = o.height - o.bare;
    const tierH = (span / o.tiers) * (o.overlap ?? 1.75);
    for (let t = 0; t < o.tiers; t++) {
      const f = t / (o.tiers - 1);
      const r = (o.base + (o.top - o.base) * f) * (0.88 + rnd() * 0.24);
      const y = o.bare + f * (span - tierH * 0.62);
      const apex = [(rnd() - 0.5) * 0.06, y + tierH, (rnd() - 0.5) * 0.06];
      const boughs = Math.max(5, Math.round((o.boughs ?? 11) - f * 4));
      const ring: number[][] = [];
      const twist = rnd() * Math.PI;
      for (let k = 0; k < boughs * 2; k++) {
        const ang = twist + ((k + (rnd() - 0.5) * 0.5) / (boughs * 2)) * Math.PI * 2;
        // Even points are bough tips; odd points are the notches between boughs.
        const out = k % 2 === 0;
        const rr = out ? r * (0.82 + rnd() * 0.34) : r * (0.5 + rnd() * 0.12);
        const yy = out ? y - o.droop * r * (0.5 + rnd() * 0.7) : y + tierH * 0.13;
        ring.push([Math.cos(ang) * rr, yy, Math.sin(ang) * rr]);
      }
      const under = [0, y + tierH * 0.3, 0];
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        m.tri(apex, b, a, crest, k % 2 === 0 ? mid : tip, k % 2 === 0 ? tip : mid);
        m.tri(under, a, b, deep, deep, deep);
      }
    }
    return m.build();
  };

  /**
   * Grows a branch and its offshoots. Each generation is shorter, thinner
   * and splays further from its parent; `lift` bends growth back toward the
   * sky. Whatever `tip` does (leaves, snow, nothing) happens at the ends.
   */
  const grow = (
    m: Mesher,
    from: V3,
    dir: THREE.Vector3,
    len: number,
    r: number,
    depth: number,
    o: { kids: number; spread: number; shrink: number; lift: number; wood: THREE.Color; tip?: (p: V3, size: number) => void },
  ) => {
    const to: V3 = [from[0] + dir.x * len, from[1] + dir.y * len, from[2] + dir.z * len];
    // Snow sits along the top of bare limbs.
    const upper = frosted && !meadow && dir.y < 0.75 ? o.wood.clone().lerp(frost, 0.55) : o.wood;
    m.stick(from, to, r, r * 0.62, o.wood, upper, depth > 1 ? 4 : 3);
    if (depth === 0) {
      o.tip?.(to, len);
      return;
    }
    for (let k = 0; k < o.kids; k++) {
      const around = (k / o.kids) * Math.PI * 2 + rnd() * 1.2;
      const side = new THREE.Vector3(Math.cos(around), 0, Math.sin(around));
      const next = dir.clone().multiplyScalar(Math.cos(o.spread)).addScaledVector(side, Math.sin(o.spread) * (0.7 + rnd() * 0.6));
      next.y += o.lift;
      next.normalize();
      // Offshoots leave from the outer part of the limb, not all from its very end.
      const s = 0.62 + rnd() * 0.38;
      const base: V3 = [from[0] + dir.x * len * s, from[1] + dir.y * len * s, from[2] + dir.z * len * s];
      grow(m, base, next, len * o.shrink * (0.85 + rnd() * 0.3), r * 0.6, depth - 1, o);
    }
  };

  const up = new THREE.Vector3(0, 1, 0);

  /** Elm: a stout trunk dividing into limbs that fan up and out, so the crown is widest at the top. */
  const elm = () => {
    const m = mesher();
    const wood = new THREE.Color(0x54463a);
    const leaf = new THREE.Color(0x4f8a3a);
    m.stick([0, 0, 0], [0, 2.6, 0], 0.34, 0.24, wood, wood, 6);
    grow(m, [0, 2.4, 0], up, 1.5, 0.22, 3, {
      kids: 3,
      spread: 0.5,
      shrink: 0.82,
      lift: 0.28,
      wood,
      tip: meadow ? (p, size) => m.clump([p[0], p[1] + 0.2, p[2]], 0.75 + size * 0.5, 0.62, leaf) : undefined,
    });
    return m.build();
  };

  /** Birch: a slim white trunk banded with dark marks, and fine branches sweeping upward. */
  const birch = () => {
    const m = mesher();
    const white = new THREE.Color(0xe6e2d8);
    const mark = new THREE.Color(0x2f2a26);
    const twig = new THREE.Color(0x5a4a40);
    const leaf = new THREE.Color(0x86b84a);
    const h = 6.4;
    const bands = 9;
    for (let k = 0; k < bands; k++) {
      const y0 = (k / bands) * h;
      const y1 = ((k + 1) / bands) * h;
      const r0 = 0.15 * (1 - k / bands) + 0.03;
      const r1 = 0.15 * (1 - (k + 1) / bands) + 0.03;
      // Mostly white, with a short dark scar at the foot of some sections.
      const scar = y0 + (y1 - y0) * 0.16;
      m.stick([0, y0, 0], [0, scar, 0], r0, r0, rnd() < 0.6 ? mark : white, white, 5);
      m.stick([0, scar, 0], [0, y1, 0], r0, r1, white, white, 5);
    }
    for (let k = 0; k < 7; k++) {
      const y = 2.2 + (k / 6) * 3.8;
      const a = k * 2.4 + rnd();
      const dir = new THREE.Vector3(Math.cos(a) * 0.62, 0.78, Math.sin(a) * 0.62).normalize();
      grow(m, [0, y, 0], dir, 1.25 - k * 0.1, 0.045, 1, {
        kids: 2,
        spread: 0.45,
        shrink: 0.7,
        lift: 0.1,
        wood: twig,
        tip: meadow ? (p) => m.clump(p, 0.5 + rnd() * 0.2, 0.8, leaf) : undefined,
      });
    }
    return m.build();
  };

  /**
   * Tamarack: a larch. In leaf it is a slim, airy cone of soft light green.
   * In winter it has dropped its needles and is just a pole with whorls of
   * short bare branches.
   */
  const tamarack = () => {
    if (meadow) return conifer({ tiers: 8, base: 1.15, top: 0.2, height: 7.4, bare: 1.4, droop: 0.18, green: 0x9cc65a, overlap: 1.15, boughs: 8, trunk: 0.15 });
    const m = mesher();
    const wood = new THREE.Color(0x6a5644);
    const h = 7.4;
    m.stick([0, 0, 0], [0, h, 0], 0.15, 0.02, wood, wood, 5);
    const whorls = 10;
    for (let k = 0; k < whorls; k++) {
      const f = k / (whorls - 1);
      const y = 1.5 + f * (h - 2.0);
      const len = 1.5 * (1 - f) + 0.25;
      const count = 4;
      for (let b = 0; b < count; b++) {
        const a = (b / count) * Math.PI * 2 + k * 0.7 + rnd() * 0.5;
        // Lower branches sag; upper ones reach up.
        const dir = new THREE.Vector3(Math.cos(a), -0.12 + f * 0.45, Math.sin(a)).normalize();
        grow(m, [0, y, 0], dir, len * (0.8 + rnd() * 0.4), 0.035, 1, { kids: 1, spread: 0.6, shrink: 0.45, lift: 0.05, wood });
      }
    }
    return m.build();
  };

  /** Maple: a short thick trunk and a wide, rounded crown. */
  const maple = () => {
    const m = mesher();
    const wood = new THREE.Color(0x4d3d31);
    const leaf = new THREE.Color(0x3f7a34);
    m.stick([0, 0, 0], [0, 1.9, 0], 0.36, 0.27, wood, wood, 6);
    grow(m, [0, 1.7, 0], up, 1.3, 0.24, 2, {
      kids: 4,
      spread: 0.85,
      shrink: 0.85,
      lift: 0.22,
      wood,
      tip: meadow ? (p, size) => m.clump([p[0], p[1] + 0.25, p[2]], 1.0 + size * 0.45, 0.8, leaf) : undefined,
    });
    if (meadow) m.clump([0, 4.6, 0], 1.7, 0.75, leaf);
    return m.build();
  };

  /** Aspen: a tall, thin, pale trunk with a small crown right at the top. */
  const aspen = () => {
    const m = mesher();
    const pale = new THREE.Color(0xc9cdb8);
    const twig = new THREE.Color(0x6a6658);
    const leaf = new THREE.Color(0x9ac44e);
    const h = 7.2;
    m.stick([0, 0, 0], [0, h, 0], 0.14, 0.04, pale, pale, 5);
    for (let k = 0; k < 6; k++) {
      const y = 4.3 + (k / 5) * 2.6;
      const a = k * 2.2 + rnd();
      const dir = new THREE.Vector3(Math.cos(a) * 0.55, 0.83, Math.sin(a) * 0.55).normalize();
      grow(m, [0, y, 0], dir, 0.95 - k * 0.08, 0.04, 1, {
        kids: 2,
        spread: 0.5,
        shrink: 0.65,
        lift: 0.1,
        wood: twig,
        tip: meadow ? (p) => m.clump(p, 0.48 + rnd() * 0.18, 0.9, leaf) : undefined,
      });
    }
    return m.build();
  };

  /** Cedar: a dense, narrow column of foliage from the ground up. */
  const cedar = () => conifer({ tiers: 9, base: 0.95, top: 0.22, height: 6.4, bare: 0.15, droop: 0.12, green: frosted ? 0x2c5c3c : 0x3d7a3a, overlap: 2.3, boughs: 9, snow: 0.7 });

  /** A dead tree: a grey, broken trunk with a few stubs of branch left. */
  const snag = () => {
    const m = mesher();
    const grey = new THREE.Color(0x77726a);
    m.stick([0, 0, 0], [0.15, 4.6, 0.1], 0.26, 0.13, grey, grey, 6);
    for (let k = 0; k < 5; k++) {
      const a = k * 1.9 + rnd();
      const y = 1.6 + k * 0.6;
      const dir = new THREE.Vector3(Math.cos(a), 0.25 + rnd() * 0.4, Math.sin(a)).normalize();
      grow(m, [0.05 * k * 0.6, y, 0.03 * k], dir, 0.7 + rnd() * 0.7, 0.07, k % 2, { kids: 1, spread: 0.6, shrink: 0.6, lift: 0, wood: grey });
    }
    return m.build();
  };

  // ----- Undergrowth -----

  /** A bush: a few lumps of leaf in spring; in winter, a mound of snow with twigs poking out. */
  const bush = (berries: boolean) => {
    const m = mesher();
    const twig = new THREE.Color(0x5a4636);
    const leaf = new THREE.Color(berries ? 0x4d7f33 : 0x5b8f3a);
    const body = frosted && !meadow ? frost.clone().multiplyScalar(0.97) : leaf;
    for (let k = 0; k < 3; k++) {
      const a = k * 2.1 + rnd();
      const off = k === 0 ? 0 : 0.45;
      m.clump([Math.cos(a) * off, 0.38 + (k === 0 ? 0.12 : 0), Math.sin(a) * off], 0.5 + rnd() * 0.2, 0.7, body);
    }
    for (let k = 0; k < 5; k++) {
      const a = k * 1.3 + rnd();
      const tip: V3 = [Math.cos(a) * 0.55, 0.85 + rnd() * 0.35, Math.sin(a) * 0.55];
      m.stick([Math.cos(a) * 0.15, 0.2, Math.sin(a) * 0.15], tip, 0.025, 0.01, twig, twig, 3);
      // Winter berries, the one spot of colour in the snow.
      if (berries) m.clump(tip, 0.075, 1, new THREE.Color(0xc62828));
    }
    return m.build();
  };

  /** A tree stump, snow-capped in winter. */
  const stump = () => {
    const m = mesher();
    const wood = new THREE.Color(0x5a4636);
    const cut = frosted && !meadow ? frost : new THREE.Color(0xc9a878);
    m.stick([0, 0, 0], [0, 0.55, 0], 0.36, 0.3, wood, wood, 7);
    m.stick([0, 0.55, 0], [0, 0.66, 0], 0.3, 0.26, cut, cut, 7);
    m.stick([0, 0.66, 0], [0, 0.67, 0], 0.26, 0.001, cut, cut, 7);
    return m.build();
  };

  /** A fallen trunk lying in the undergrowth. */
  const deadfall = () => {
    const m = mesher();
    const wood = new THREE.Color(0x4f3d2f);
    const top = frosted && !meadow ? wood.clone().lerp(frost, 0.7) : new THREE.Color(0x5f7a3a);
    m.stick([-2.2, 0.22, 0], [2.2, 0.3, 0.3], 0.26, 0.17, wood, top, 6);
    m.stick([0.6, 0.3, 0.05], [1.0, 1.0, -0.5], 0.06, 0.02, wood, wood, 3);
    m.stick([-0.9, 0.28, 0], [-1.2, 0.85, 0.5], 0.06, 0.02, wood, wood, 3);
    return m.build();
  };

  const species: TreeSpecies[] = [
    { name: 'spruce', geo: conifer({ tiers: 6, base: 1.75, top: 0.32, height: 6.2, bare: 0.5, droop: 0.34, green: frosted ? 0x1f4a38 : 0x2f6a3d }), share: 0.2 },
    // Douglas fir: the giant of the forest. Narrow for its height, dark, boughs hanging long.
    { name: 'douglas fir', geo: conifer({ tiers: 9, base: 1.55, top: 0.18, height: 10.2, bare: 1.3, droop: 0.5, green: frosted ? 0x183f33 : 0x245a38, overlap: 1.95, trunk: 0.3, snow: 0.8 }), share: 0.2 },
    // White pine: long clear trunk, then open whorls held level with the trunk showing between them.
    { name: 'white pine', geo: conifer({ tiers: 5, base: 2.0, top: 0.75, height: 8.4, bare: 3.0, droop: -0.06, green: frosted ? 0x2a5a4c : 0x3a7450, overlap: 0.85, boughs: 8, trunk: 0.24, snow: 0.9 }), share: 0.18 },
    { name: 'young fir', geo: conifer({ tiers: 4, base: 1.2, top: 0.3, height: 3.4, bare: 0.3, droop: 0.3, green: frosted ? 0x2a5a40 : 0x3f7d45 }), share: 0.12 },
    { name: 'tamarack', geo: tamarack(), share: 0.12 },
    { name: 'elm', geo: elm(), share: 0.08 },
    { name: 'birch', geo: birch(), share: 0.1 },
    { name: 'cedar', geo: cedar(), share: 0.1 },
    { name: 'maple', geo: maple(), share: 0.05 },
    { name: 'aspen', geo: aspen(), share: 0.06 },
    { name: 'snag', geo: snag(), share: 0.03 },
    // Undergrowth: shares are of the undergrowth, not of the trees.
    { name: 'bush', geo: bush(false), share: 0.5, low: true },
    { name: 'berry bush', geo: bush(true), share: 0.22, low: true },
    { name: 'stump', geo: stump(), share: 0.16, low: true },
    { name: 'deadfall', geo: deadfall(), share: 0.12, low: true },
  ];
  // Eleven kinds of tree now: scale the first seven down so the shares still add up to one.
  for (const sp of species.slice(0, 7)) sp.share *= 0.76;
  if (meadow) {
    // Down in the valley in spring the broadleaf trees take over.
    const shares: Record<string, number> = {
      spruce: 0.09,
      'douglas fir': 0.09,
      'white pine': 0.1,
      'young fir': 0.06,
      tamarack: 0.1,
      elm: 0.13,
      birch: 0.12,
      cedar: 0.07,
      maple: 0.12,
      aspen: 0.1,
      snag: 0.02,
    };
    for (const sp of species) if (!sp.low) sp.share = shares[sp.name];
  }
  return species;
}