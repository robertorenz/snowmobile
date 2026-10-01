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
  readonly mesh: THREE.Mesh;
  readonly sizeX: number;
  readonly sizeZ: number;

  constructor(track: Track) {
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
      const bx = Math.floor((track.px[i] - minX) / BUCKET);
      const bz = Math.floor((track.pz[i] - minZ) / BUCKET);
      (buckets[bz * bnx + bx] ??= []).push(i);
    }
    const reach = Math.ceil(FAR / BUCKET);

    // Sparse samples used to carry the track's elevation out into the far field.
    const coarse: number[] = [];
    for (let i = 0; i < track.n; i += 10) coarse.push(i);

    const heights = new Float32Array(nx * nz);
    const dist = new Float32Array(nx * nz);
    const lat = new Float32Array(nx * nz);
    const hwv = new Float32Array(nx * nz);

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
        if (bi >= 0) {
          hw = track.hw[bi];
          dd = Math.min(FAR, Math.sqrt(best));
          const rx = x - track.px[bi];
          const rz = z - track.pz[bi];
          const along = clamp(rx * track.tx[bi] + rz * track.tz[bi], -track.ds, track.ds);
          trackH = track.py[bi] + along * track.slope[bi];
          side = rx * track.lx[bi] + rz * track.lz[bi] >= 0 ? 1 : -1;
        }

        const rise = smoothstep(hw + 6, hw + 150, dd);
        const ridge = noise.fbm(x * 0.0035, z * 0.0035, 4) * 0.5 + 0.5;
        const mountains = def.mountain * (0.25 + 0.75 * ridge) * Math.pow(rise, 1.4);
        const bumps = noise.fbm(x * 0.03, z * 0.03, 3) * 2.4 * smoothstep(hw + 2, hw + 25, dd);
        const t = smoothstep(hw + 1.5, hw + 1.5 + BLEND, dd);

        const idx = iz * nx + ix;
        heights[idx] = trackH * (1 - t) + (far + mountains + bumps) * t;
        dist[idx] = dd;
        lat[idx] = dd * side;
        hwv[idx] = hw;
      }
    }
    this.heights = heights;
    this.dist = dist;
    this.halfWidths = hwv;

    // Mesh
    const pos = new Float32Array(nx * nz * 3);
    const col = new Float32Array(nx * nz * 3);
    const snow = new THREE.Color(theme.snowTint);
    const rock = new THREE.Color(0x5b626b);
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
        const shade = 0.95 + 0.05 * noise.noise2(x * 0.02, z * 0.02);
        col[i * 3] = (snow.r * (1 - rocky) + rock.r * rocky) * shade;
        col[i * 3 + 1] = (snow.g * (1 - rocky) + rock.g * rocky) * shade;
        col[i * 3 + 2] = (snow.b * (1 - rocky) + rock.b * rocky) * shade;
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
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();

    this.mesh = new THREE.Mesh(geo, makeSnowMaterial(track));
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
function makeSnowMaterial(track: Track) {
  const theme = track.def.theme;
  const line = (i: number) => new THREE.Vector4(track.px[i], track.pz[i], track.tx[i], track.tz[i]);
  const uniforms = {
    uTrackColor: { value: new THREE.Color(theme.trackTint) },
    uEdgeL: { value: new THREE.Color(0x1d6fd1) },
    uEdgeR: { value: new THREE.Color(0xd8343a) },
    uLineA: { value: line(track.startIdx) },
    uLineB: { value: line(track.finishIdx) },
  };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float lat;
        attribute float trackHW;
        varying float vLat;
        varying float vHW;
        varying vec2 vWXZ;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vLat = lat;
        vHW = trackHW;
        vWXZ = position.xz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vLat;
        varying vec2 vWXZ;
        varying float vHW;
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
          float onTrack = 1.0 - smoothstep(vHW - 0.4, vHW + 0.4, d);
          vec3 groomed = uTrackColor * (0.97 + 0.03 * sin(vLat * 7.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, groomed, onTrack);
          float edge = smoothstep(vHW - 1.5, vHW - 1.25, d) * (1.0 - smoothstep(vHW - 0.55, vHW - 0.3, d));
          diffuseColor.rgb = mix(diffuseColor.rgb, vLat > 0.0 ? uEdgeL : uEdgeR, edge * 0.85);
          float ca = chequer(uLineA, onTrack);
          float cb = chequer(uLineB, onTrack);
          float c = max(ca, cb);
          if (c >= 0.0) diffuseColor.rgb = mix(vec3(0.05), vec3(0.97), c);
        }`,
      );
  };
  return mat;
}
