import * as THREE from 'three';
import { Track } from './track';
import { makeNoise } from './noise';
import { clamp, smoothstep } from './util';

const MARGIN = 190;
/** Beyond this distance from the track the terrain no longer cares about it. */
const FAR = 150;
/** Width of the band where the flat track surface blends into the hills. */
const BLEND = 40;
const BUCKET = 50;
/** How far the river bed sits below the track, and the water surface above the bed. */
export const RIVER_DEPTH = 3.6;
export const RIVER_WATER = 2.2;
export const CHASM_DEPTH = 14;

/**
 * Heightmap terrain shaped around a track: flat across the racing surface,
 * rising into noisy hills and mountains further out.
 */
export class Terrain {
  readonly minX: number;
  readonly minZ: number;
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  readonly heights: Float32Array;
  /** Distance from each grid vertex to the track centerline (capped at FAR). */
  readonly dist: Float32Array;
  /** Track half-width at the nearest point of the course, per grid vertex. */
  readonly halfWidths: Float32Array;
  /** 0..1 per grid vertex: how deep into the river channel, and how far onto the lake ice. */
  readonly wet: Float32Array;
  readonly ice: Float32Array;
  readonly mesh: THREE.Mesh;
  readonly sizeX: number;
  readonly sizeZ: number;

  constructor(track: Track, plain = false) {
    const def = track.def;
    const theme = def.theme;
    const noise = makeNoise(def.seed);

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < track.n; i++) {
      minX = Math.min(minX, track.px[i]);
      maxX = Math.max(maxX, track.px[i]);
      minZ = Math.min(minZ, track.pz[i]);
      maxZ = Math.max(maxZ, track.pz[i]);
    }
    minX -= MARGIN;
    maxX += MARGIN;
    minZ -= MARGIN;
    maxZ += MARGIN;
    const w = maxX - minX;
    const d = maxZ - minZ;
    const cell = Math.max(2.5, Math.sqrt((w * d) / 300000));
    const nx = Math.ceil(w / cell) + 1;
    const nz = Math.ceil(d / cell) + 1;
    this.minX = minX;
    this.minZ = minZ;
    this.cell = cell;
    this.nx = nx;
    this.nz = nz;
    this.sizeX = (nx - 1) * cell;
    this.sizeZ = (nz - 1) * cell;

    // Bucket the centerline samples so each vertex only checks nearby ones.
    const bnx = Math.ceil(w / BUCKET) + 1;
    const bnz = Math.ceil(d / BUCKET) + 1;
    const buckets: number[][] = new Array(bnx * bnz);
    for (let i = 0; i < track.n; i++) {
      // A bridge deck isn't ground: the land under it belongs to the road below.
      if (track.bridge[i]) continue;
      const bx = Math.floor((track.px[i] - minX) / BUCKET);
      const bz = Math.floor((track.pz[i] - minZ) / BUCKET);
      (buckets[bz * bnx + bx] ??= []).push(i);
    }
    const reach = Math.ceil(FAR / BUCKET);

    // Sparse samples used to carry the track's elevation out into the far field.
    const coarse: number[] = [];
    for (let i = 0; i < track.n; i += 10) if (!track.bridge[i]) coarse.push(i);

    const heights = new Float32Array(nx * nz);
    const dist = new Float32Array(nx * nz);
    const lat = new Float32Array(nx * nz);
    const hwv = new Float32Array(nx * nz);
    // Per vertex: how much ice, shale, rock and grass the racing surface shows here.
    const surf = new Float32Array(nx * nz * 4);
    const wet = new Float32Array(nx * nz);
    const ice = new Float32Array(nx * nz);
    const river = def.river;
    const lake = def.lake;
    const rugged = def.rugged ?? 0.5;

    for (let iz = 0; iz < nz; iz++) {
      const z = minZ + iz * cell;
      const bz = Math.floor((z - minZ) / BUCKET);
      for (let ix = 0; ix < nx; ix++) {
        const x = minX + ix * cell;
        const bx = Math.floor((x - minX) / BUCKET);

        let best = Infinity;
        let bi = -1;
        for (let dz = -reach; dz <= reach; dz++) {
          const cz = bz + dz;
          if (cz < 0 || cz >= bnz) continue;
          for (let dx = -reach; dx <= reach; dx++) {
            const cx = bx + dx;
            if (cx < 0 || cx >= bnx) continue;
            const list = buckets[cz * bnx + cx];
            if (!list) continue;
            for (let k = 0; k < list.length; k++) {
              const i = list[k];
              const ex = x - track.px[i];
              const ez = z - track.pz[i];
              const e = ex * ex + ez * ez;
              if (e < best) {
                best = e;
                bi = i;
              }
            }
          }
        }

        let far = 0;
        let wsum = 0;
        for (let k = 0; k < coarse.length; k++) {
          const i = coarse[k];
          const ex = x - track.px[i];
          const ez = z - track.pz[i];
          const q = ex * ex + ez * ez + 900;
          const wgt = 1 / (q * q);
          far += track.py[i] * wgt;
          wsum += wgt;
        }
        far /= wsum;

        let dd = FAR;
        let trackH = far;
        let side = 1;
        let hw = track.halfWidth;
        let pathS = 0;
        if (bi >= 0) {
          hw = track.hw[bi];
          dd = Math.min(FAR, Math.sqrt(best));
          const rx = x - track.px[bi];
          const rz = z - track.pz[bi];
          const along = clamp(rx * track.tx[bi] + rz * track.tz[bi], -track.ds, track.ds);
          trackH = track.py[bi] + along * track.slope[bi];
          pathS = bi * track.ds + along;
          side = rx * track.lx[bi] + rz * track.lz[bi] >= 0 ? 1 : -1;
        }

        const rise = smoothstep(hw + 6, hw + 150, dd);
        const ridge = noise.fbm(x * 0.0035, z * 0.0035, 4) * 0.5 + 0.5;
        const mountains = def.mountain * (0.25 + 0.75 * ridge) * Math.pow(rise, 1.4);
        const bumps = noise.fbm(x * 0.03, z * 0.03, 3) * 2.4 * smoothstep(hw + 2, hw + 25, dd);
        const t = smoothstep(hw + 1.5, hw + 1.5 + BLEND, dd);

        const idx = iz * nx + ix;
        // Rock ridges: sharp crests that rise close beside the course in places, steep enough to show bare rock.
        const ridgeLine = 1 - Math.min(1, Math.abs(noise.fbm(x * 0.011 + 31, z * 0.011 - 17, 3)) * 2.6);
        const patchy = smoothstep(0.38, 0.62, noise.fbm(x * 0.0045 - 9, z * 0.0045 + 4, 2) * 0.5 + 0.5);
        const crags = rugged * 26 * ridgeLine * ridgeLine * ridgeLine * (0.35 + 0.65 * patchy) * smoothstep(hw + 7, hw + 30, dd);
        let h = trackH * (1 - t) + (far + mountains + bumps + crags) * t;

        // River: a channel cut alongside the track.
        if (river && bi >= 0) {
          const u = bi / track.n;
          const reach = smoothstep(river.from, river.from + 0.03, u) * (1 - smoothstep(river.to - 0.03, river.to, u));
          if (reach > 0) {
            const centre = river.side * (hw + river.gap);
            const m = (1 - smoothstep(river.width / 2, river.width / 2 + 6, Math.abs(dd * side - centre))) * reach;
            h = h * (1 - m) + (trackH - RIVER_DEPTH) * m;
            wet[idx] = m;
          }
        }
        // Crossings: a river or chasm cut straight across the course, or a level bed for a highway.
        for (const c of track.crossings) {
          if (bi < 0 || c.kind === 'gate') continue;
          const q = Math.abs(pathS - c.s);
          if (q > c.half + 12) continue;
          const reach = 1 - smoothstep(70, 95, dd);
          if (c.kind === 'highway') {
            const m = (1 - smoothstep(c.half + 0.5, c.half + 2.5, q)) * reach;
            h = h * (1 - m) + c.y * m;
          } else {
            const m = (1 - smoothstep(c.half - 1.5, c.half + 1.5, q)) * reach;
            h = h * (1 - m) + (c.y - (c.kind === 'chasm' ? CHASM_DEPTH : RIVER_DEPTH)) * m;
            wet[idx] = Math.max(wet[idx], m);
          }
        }
        // Frozen lake: a dead-flat sheet of ice.
        if (lake) {
          const m = 1 - smoothstep(0.82, 1.08, Math.hypot((x - lake.x) / lake.rx, (z - lake.z) / lake.rz));
          h = h * (1 - m) + lake.y * m;
          ice[idx] = m;
        }
        heights[idx] = h;
        dist[idx] = dd;
        lat[idx] = dd * side;
        hwv[idx] = hw;
        if (bi >= 0 && track.surface[bi] && dd < hw + 3) {
          const sideOf = track.surfSide[bi];
          const across = sideOf === 0 ? 1 : smoothstep(-1.2, 1.2, dd * side * sideOf);
          surf[idx * 4 + track.surface[bi] - 1] = track.surfFade[bi] * across;
        }
      }
    }
    // Shortcuts: a narrow groomed way cut across country. Laid over the finished ground, leaving the road itself alone.
    for (const sc of track.shortcuts) {
      const reach = sc.hw + 18;
      const ix0 = Math.max(0, Math.floor((sc.minX - reach - minX) / cell));
      const ix1 = Math.min(nx - 1, Math.ceil((sc.maxX + reach - minX) / cell));
      const iz0 = Math.max(0, Math.floor((sc.minZ - reach - minZ) / cell));
      const iz1 = Math.min(nz - 1, Math.ceil((sc.maxZ + reach - minZ) / cell));
      for (let iz = iz0; iz <= iz1; iz++) {
        const z = minZ + iz * cell;
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = minX + ix * cell;
          let best = Infinity;
          let bk = 0;
          for (let k = 0; k < sc.n; k++) {
            const ex = x - sc.x[k];
            const ez = z - sc.z[k];
            const e = ex * ex + ez * ez;
            if (e < best) {
              best = e;
              bk = k;
            }
          }
          const d = Math.sqrt(best);
          if (d > reach) continue;
          const k0 = Math.max(0, bk - 1);
          const k1 = Math.min(sc.n - 1, bk + 1);
          const tx = sc.x[k1] - sc.x[k0];
          const tz = sc.z[k1] - sc.z[k0];
          const tl = Math.hypot(tx, tz) || 1;
          const rx = x - sc.x[bk];
          const rz = z - sc.z[bk];
          const along = clamp((rx * tx + rz * tz) / tl, -2, 2);
          const level = sc.y[bk] + (along * (sc.y[k1] - sc.y[k0])) / tl;
          const idx = iz * nx + ix;
          // 0 on the road proper, 1 clear of it: the fork and the merge keep the road's own shape.
          const keep = smoothstep(hwv[idx] + 1, hwv[idx] + 9, dist[idx]);
          const m = (1 - smoothstep(sc.hw + 1.5, reach, d)) * keep;
          heights[idx] = heights[idx] * (1 - m) + level * m;
          if (sc.ice) ice[idx] = Math.max(ice[idx], (1 - smoothstep(sc.hw - 1.2, sc.hw + 0.3, d)) * keep);
          if (d - sc.hw < dist[idx] - hwv[idx]) {
            dist[idx] = d;
            lat[idx] = (rx * tz - rz * tx) / tl;
            hwv[idx] = sc.hw;
            surf.fill(0, idx * 4, idx * 4 + 4);
          }
        }
      }
    }
    this.heights = heights;
    this.dist = dist;
    this.halfWidths = hwv;
    this.wet = wet;
    this.ice = ice;

    // Mesh
    const pos = new Float32Array(nx * nz * 3);
    const col = new Float32Array(nx * nz * 3);
    const snow = new THREE.Color(theme.snowTint);
    const rock = new THREE.Color(theme.meadow ? 0x6e675c : 0x5b626b);
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        const x = minX + ix * cell;
        const z = minZ + iz * cell;
        pos[i * 3] = x;
        pos[i * 3 + 1] = heights[i];
        pos[i * 3 + 2] = z;

        const xl = heights[iz * nx + Math.max(0, ix - 1)];
        const xr = heights[iz * nx + Math.min(nx - 1, ix + 1)];
        const zu = heights[Math.max(0, iz - 1) * nx + ix];
        const zd = heights[Math.min(nz - 1, iz + 1) * nx + ix];
        const steep = Math.hypot(xr - xl, zd - zu) / (2 * cell);
        const rocky = smoothstep(0.8, 1.2, steep + noise.noise2(x * 0.08, z * 0.08) * 0.15);
        // Grass varies more than snow does.
        const shade = theme.meadow
          ? 0.85 + 0.18 * noise.fbm(x * 0.015, z * 0.015, 3) + 0.06 * noise.noise2(x * 0.4, z * 0.4)
          : 0.95 + 0.05 * noise.noise2(x * 0.02, z * 0.02);
        // Rock shows its layers.
        const strata = 0.82 + 0.18 * Math.sin(heights[i] * 0.9 + noise.noise2(x * 0.05, z * 0.05) * 2.5);
        const lit = shade * (1 - rocky) + strata * rocky;
        col[i * 3] = (snow.r * (1 - rocky) + rock.r * rocky) * lit;
        col[i * 3 + 1] = (snow.g * (1 - rocky) + rock.g * rocky) * lit;
        col[i * 3 + 2] = (snow.b * (1 - rocky) + rock.b * rocky) * lit;
      }
    }
    const index = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let p = 0;
    for (let iz = 0; iz < nz - 1; iz++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const a = iz * nx + ix;
        const b = a + 1;
        const c = a + nx;
        const e = c + 1;
        index[p++] = a;
        index[p++] = c;
        index[p++] = b;
        index[p++] = b;
        index[p++] = c;
        index[p++] = e;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('lat', new THREE.BufferAttribute(lat, 1));
    geo.setAttribute('trackHW', new THREE.BufferAttribute(hwv, 1));
    geo.setAttribute('ice', new THREE.BufferAttribute(ice, 1));
    geo.setAttribute('surf', new THREE.BufferAttribute(surf, 4));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();

    this.mesh = new THREE.Mesh(geo, makeSnowMaterial(track, plain));
    this.mesh.receiveShadow = true;
  }

  height(x: number, z: number) {
    const fx = clamp((x - this.minX) / this.cell, 0, this.nx - 1.001);
    const fz = clamp((z - this.minZ) / this.cell, 0, this.nz - 1.001);
    const ix = fx | 0;
    const iz = fz | 0;
    const u = fx - ix;
    const v = fz - iz;
    const i = iz * this.nx + ix;
    const H = this.heights;
    const a = H[i] + (H[i + 1] - H[i]) * u;
    const b = H[i + this.nx] + (H[i + this.nx + 1] - H[i + this.nx]) * u;
    return a + (b - a) * v;
  }

  /** Distance beyond the edge of the racing surface (negative on the track), from the baked grid. */
  edgeAt(x: number, z: number) {
    const ix = clamp(Math.round((x - this.minX) / this.cell), 0, this.nx - 1);
    const iz = clamp(Math.round((z - this.minZ) / this.cell), 0, this.nz - 1);
    const i = iz * this.nx + ix;
    return this.dist[i] - this.halfWidths[i];
  }

  private sample(grid: Float32Array, x: number, z: number) {
    const ix = clamp(Math.round((x - this.minX) / this.cell), 0, this.nx - 1);
    const iz = clamp(Math.round((z - this.minZ) / this.cell), 0, this.nz - 1);
    return grid[iz * this.nx + ix];
  }

  /** 0..1: how far into the river this point is. */
  wetAt(x: number, z: number) {
    return this.sample(this.wet, x, z);
  }

  /** 0..1: how far onto the frozen lake this point is. */
  iceAt(x: number, z: number) {
    return this.sample(this.ice, x, z);
  }

  normal(x: number, z: number, out: THREE.Vector3) {
    const e = 1.2;
    const gx = (this.height(x + e, z) - this.height(x - e, z)) / (2 * e);
    const gz = (this.height(x, z + e) - this.height(x, z - e)) / (2 * e);
    return out.set(-gx, 1, -gz).normalize();
  }
}

/**
 * Snow material with the groomed racing surface, coloured edge lines and the
 * chequered start/finish lines drawn in the shader, so they stay crisp
 * regardless of terrain resolution.
 */
function makeSnowMaterial(track: Track, plain: boolean) {
  const theme = track.def.theme;
  const line = (i: number) => new THREE.Vector4(track.px[i], track.pz[i], track.tx[i], track.tz[i]);
  const uniforms = {
    uSoft: { value: theme.meadow ? 2.2 : 0.4 },
    uTrackColor: { value: new THREE.Color(theme.trackTint) },
    uEdgeL: { value: new THREE.Color(0x1d6fd1) },
    uEdgeR: { value: new THREE.Color(0xd8343a) },
    uLineA: { value: line(track.startIdx) },
    uLineB: { value: line(track.finishIdx) },
  };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (plain) shader.fragmentShader = '#define PLAIN_GROUND\n' + shader.fragmentShader;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float lat;
        attribute float trackHW;
        attribute float ice;
        attribute vec4 surf;
        varying float vIce;
        varying vec4 vSurf;
        varying float vLat;
        varying float vHW;
        varying vec2 vWXZ;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vLat = lat;
        vHW = trackHW;
        vIce = ice;
        vSurf = surf;
        vWXZ = position.xz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vLat;
        varying vec2 vWXZ;
        varying float vHW;
        varying float vIce;
        varying vec4 vSurf;
        uniform float uSoft;
        float hash2(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float vnoise(vec2 p) {
          // Low graphics: no texture in the ground, just flat colour.
          #ifdef PLAIN_GROUND
            return 0.5;
          #endif
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        uniform vec3 uTrackColor;
        uniform vec3 uEdgeL;
        uniform vec3 uEdgeR;
        uniform vec4 uLineA;
        uniform vec4 uLineB;
        float chequer(vec4 line, float onTrack) {
          vec2 rel = vWXZ - line.xy;
          float al = dot(rel, line.zw);
          float la = dot(rel, vec2(line.w, -line.z));
          if (abs(al) > 1.8 || abs(la) > vHW + 8.0) return -1.0;
          return onTrack > 0.5 ? mod(floor(al / 0.9) + floor(la / 0.9), 2.0) : -1.0;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float d = abs(vLat);
          // On a meadow the snow road has a ragged, melting edge.
          float rag = uSoft > 1.0 ? sin(vWXZ.x * 0.7) * sin(vWXZ.y * 0.9) * 0.9 : 0.0;
          float onTrack = 1.0 - smoothstep(vHW - 0.4 + rag, vHW + uSoft + rag, d);
          float iceAmt = smoothstep(0.35, 0.65, vIce);
          vec3 iceCol = vec3(0.2, 0.47, 0.74) * (0.93 + 0.07 * sin(vWXZ.x * 0.31 + sin(vWXZ.y * 0.23) * 3.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, iceCol, iceAmt);
          vec3 groomed = uTrackColor * (0.97 + 0.03 * sin(vLat * 7.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, groomed, onTrack * (1.0 - 0.75 * iceAmt));
          // Patches of other ground showing through the snow road.
          {
            vec4 s = vSurf * onTrack;
            vec3 sheet = vec3(0.2, 0.47, 0.74) * (0.9 + 0.1 * vnoise(vWXZ * 0.6));
            float grit = vnoise(vWXZ * 3.1) * 0.6 + hash2(floor(vWXZ * 6.0)) * 0.4;
            vec3 shale = mix(vec3(0.2, 0.19, 0.18), vec3(0.43, 0.4, 0.36), grit);
            float slab = vnoise(vWXZ * 0.45);
            float crack = smoothstep(0.06, 0.0, abs(fract(slab * 4.0) - 0.5));
            vec3 stone = mix(vec3(0.36, 0.37, 0.4), vec3(0.52, 0.53, 0.55), vnoise(vWXZ * 1.4)) * (1.0 - 0.45 * crack);
            // Matted winter grass: mostly covered, with snow lying in the hollows and dry straw mixed in.
            float tuft = smoothstep(0.3, 0.5, vnoise(vWXZ * 0.55) * 0.55 + vnoise(vWXZ * 2.3) * 0.3 + vnoise(vWXZ * 9.0) * 0.15);
            vec3 turf = mix(vec3(0.19, 0.3, 0.12), vec3(0.36, 0.45, 0.2), vnoise(vWXZ * 1.7));
            turf = mix(turf, vec3(0.55, 0.5, 0.3), smoothstep(0.55, 0.8, vnoise(vWXZ * 4.3 + 17.0)) * 0.7);
            turf *= 0.84 + 0.32 * vnoise(vWXZ * 11.0);
            diffuseColor.rgb = mix(diffuseColor.rgb, sheet, s.x);
            diffuseColor.rgb = mix(diffuseColor.rgb, shale, s.y);
            diffuseColor.rgb = mix(diffuseColor.rgb, stone, s.z);
            diffuseColor.rgb = mix(diffuseColor.rgb, turf, s.w * tuft);
          }
          float edge = smoothstep(vHW - 1.5, vHW - 1.25, d) * (1.0 - smoothstep(vHW - 0.55, vHW - 0.3, d));
          diffuseColor.rgb = mix(diffuseColor.rgb, vLat > 0.0 ? uEdgeL : uEdgeR, edge * 0.85);
          float ca = chequer(uLineA, onTrack);
          float cb = chequer(uLineB, onTrack);
          float c = max(ca, cb);
          if (c >= 0.0) diffuseColor.rgb = mix(vec3(0.05), vec3(0.97), c);
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.32, max(smoothstep(0.35, 0.65, vIce), vSurf.x * (1.0 - smoothstep(vHW - 0.4, vHW + 0.4, abs(vLat)))));`,
      );
  };
  return mat;
}
