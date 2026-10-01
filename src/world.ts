import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Track, GATE_HEIGHT } from './track';
import { Terrain, RIVER_DEPTH, RIVER_WATER, CHASM_DEPTH } from './terrain';
import type { TrackDef, Theme } from './tracks';
import { mulberry32 } from './util';

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
function softDot() {
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
  private skyGroup = new THREE.Group();
  private snowMat?: THREE.ShaderMaterial;
  private auroraMat?: THREE.ShaderMaterial;
  private time = 0;
  readonly vehicles: Vehicle[] = [];

  constructor(readonly def: TrackDef) {
    const theme = (this.theme = def.theme);
    this.track = new Track(def);
    this.terrain = new Terrain(this.track);
    for (let i = 0; i < this.track.n; i++) {
      this.track.ice[i] = this.terrain.iceAt(this.track.px[i], this.track.pz[i]) > 0.5 ? 1 : 0;
    }
    this.scene.add(this.terrain.mesh);
    this.scene.add(this.spray.points);

    this.scene.fog = new THREE.Fog(theme.fog, theme.fogNear, theme.fogFar);
    this.scene.background = new THREE.Color(theme.fog);

    const hemi = new THREE.HemisphereLight(theme.ambientSky, theme.ambientGround, theme.ambientIntensity);
    this.scene.add(hemi);

    const sun = (this.sun = new THREE.DirectionalLight(theme.sun, theme.sunIntensity));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
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
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    this.skyGroup.add(sky);

    if (theme.stars) {
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
        new THREE.PointsMaterial({ color: 0xdcecff, size: 1.8, sizeAttenuation: false, fog: false, depthWrite: false }),
      );
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
    const count = theme.snowfall;
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

    // --- Trees ---
    const treeGeo = makeTreeGeometry(!theme.meadow);
    const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    const trees = new THREE.InstancedMesh(treeGeo, treeMat, def.trees);
    let placed = 0;
    let tries = 0;
    while (placed < def.trees && tries < def.trees * 40) {
      tries++;
      const x = terrain.minX + rnd() * terrain.sizeX;
      const z = terrain.minZ + rnd() * terrain.sizeZ;
      const d = terrain.edgeAt(x, z);
      if (d < 3.5 || terrain.wetAt(x, z) > 0.02 || terrain.iceAt(x, z) > 0.02 || this.onRoad(x, z)) continue;
      // Dense forest lining the course, thinning out up the slopes.
      const keep = d < 45 ? 0.9 : d < 118 ? 0.35 : 0.05;
      if (rnd() > keep) continue;
      terrain.normal(x, z, v);
      if (v.y < 0.78) continue;
      const scale = 0.9 + rnd() * 1.1;
      q.setFromAxisAngle(yAxis, rnd() * Math.PI * 2);
      s.set(scale, scale * (0.9 + rnd() * 0.35), scale);
      v.set(x, terrain.height(x, z) - 0.15, z);
      trees.setMatrixAt(placed++, m.compose(v, q, s));
      if (d < 60) this.colliders.add({ x, z, r: 0.35 * scale });
    }
    trees.count = placed;
    trees.castShadow = true;
    trees.receiveShadow = true;
    trees.frustumCulled = false;
    this.scene.add(trees);

    // --- Rocks ---
    const rockCount = 160;
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

    // --- Obstacles on the racing surface ---
    if (track.obstacles.length) {
      const sc = document.createElement('canvas');
      sc.width = 256;
      sc.height = 64;
      const sg = sc.getContext('2d')!;
      sg.fillStyle = '#f6a821';
      sg.fillRect(0, 0, 256, 64);
      sg.fillStyle = '#14181d';
      for (let x = -64; x < 256; x += 64) {
        sg.beginPath();
        sg.moveTo(x, 64);
        sg.lineTo(x + 32, 64);
        sg.lineTo(x + 96, 0);
        sg.lineTo(x + 64, 0);
        sg.fill();
      }
      const stripes = new THREE.CanvasTexture(sc);
      stripes.colorSpace = THREE.SRGBColorSpace;
      const barrierMat = new THREE.MeshStandardMaterial({
        map: stripes,
        roughness: 0.7,
        emissive: 0xffffff,
        emissiveMap: stripes,
        emissiveIntensity: theme.night ? 0.7 : 0.25,
      });
      const iceMat = new THREE.MeshStandardMaterial({ color: 0x3f86c4, roughness: 0.3, flatShading: true });
      const barrierGeo = new THREE.BoxGeometry(2.5, 1.1, 0.55);
      const boulderGeo = new THREE.DodecahedronGeometry(1, 0);
      for (const o of track.obstacles) {
        const y = terrain.height(o.x, o.z);
        let mesh: THREE.Mesh;
        if (o.kind === 'barrier') {
          mesh = new THREE.Mesh(barrierGeo, barrierMat);
          mesh.position.set(o.x, y + 0.55, o.z);
          mesh.rotation.y = track.yawAt(o.idx);
        } else {
          mesh = new THREE.Mesh(boulderGeo, iceMat);
          mesh.position.set(o.x, y + o.radius * 0.35, o.z);
          mesh.scale.set(o.radius, o.radius * 0.8, o.radius);
          mesh.rotation.y = o.idx;
        }
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.colliders.add({ x: o.x, z: o.z, r: o.radius });
      }
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

    this.buildCrossings();

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

  /** Per-frame upkeep: keep sky, snowfall and shadows centred on the action. */
  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3) {
    this.time += dt;
    this.skyGroup.position.copy(camera.position);
    if (this.snowMat) {
      this.snowMat.uniforms.uTime.value = this.time;
      (this.snowMat.uniforms.uCam.value as THREE.Vector3).copy(camera.position);
    }
    if (this.auroraMat) this.auroraMat.uniforms.uTime.value = this.time;
    const d = this.theme.sunDir;
    const l = Math.hypot(d[0], d[1], d[2]);
    this.sun.target.position.copy(focus);
    this.sun.position.set(focus.x + (d[0] / l) * 200, focus.y + (d[1] / l) * 200, focus.z + (d[2] / l) * 200);
    this.spray.update(dt);
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

/** A snow-dusted pine: trunk plus three cone tiers, coloured per vertex. */
function makeTreeGeometry(frosted: boolean) {
  const parts: THREE.BufferGeometry[] = [];
  const paint = (g: THREE.BufferGeometry, fn: (y: number) => THREE.Color) => {
    const p = g.attributes.position;
    const c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const col = fn(p.getY(i));
      c[i * 3] = col.r;
      c[i * 3 + 1] = col.g;
      c[i * 3 + 2] = col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  };
  const trunk = new THREE.CylinderGeometry(0.16, 0.22, 1.4, 6);
  trunk.translate(0, 0.7, 0);
  const bark = new THREE.Color(0x4a3628);
  paint(trunk, () => bark);
  parts.push(trunk);

  const green = new THREE.Color(frosted ? 0x1f4a38 : 0x2c6a3c);
  const frost = new THREE.Color(0xe9f2f8);
  const tiers: [number, number, number][] = [
    [1.55, 2.3, 1.0],
    [1.2, 2.0, 2.3],
    [0.8, 1.8, 3.5],
  ];
  for (const [r, h, y] of tiers) {
    const cone = new THREE.ConeGeometry(r, h, 8);
    const tmp = new THREE.Color();
    // Snow settles on the upper part of each tier.
    paint(cone, (py) => tmp.copy(green).lerp(frost, frosted ? Math.pow((py + h / 2) / h, 1.6) * 0.9 : 0));
    cone.translate(0, y + h / 2, 0);
    parts.push(cone);
  }
  return mergeGeometries(parts)!;
}
