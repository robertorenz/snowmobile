import * as THREE from 'three';
import type { World } from './world';
import { softDot } from './world';
import { mulberry32 } from './util';

/**
 * Life around the course that has nothing to do with the race: clouds
 * drifting over, birds circling, hot-air balloons, an airliner crossing now
 * and then, and a steam train working along the mountainside.
 */
export class Ambient {
  /** Deer on or near the road: where they are, and a way to scare them off. */
  readonly animals: { x: number; z: number; onRoad: boolean; scare: () => void }[] = [];
  private time = 0;
  private updaters: ((dt: number, t: number) => void)[] = [];
  private rnd: () => number;
  /** Middle of the map, its half-extents, and the highest point of the course. */
  private cx: number;
  private cz: number;
  private rx: number;
  private rz: number;
  private top: number;

  constructor(private world: World) {
    const { terrain, track, theme, def } = world;
    this.rnd = mulberry32(def.seed * 53 + 11);
    this.cx = terrain.minX + terrain.sizeX / 2;
    this.cz = terrain.minZ + terrain.sizeZ / 2;
    this.rx = terrain.sizeX / 2;
    this.rz = terrain.sizeZ / 2;
    let top = -Infinity;
    for (let i = 0; i < track.n; i++) top = Math.max(top, track.py[i]);
    this.top = top;

    // In a blizzard none of the sky can be seen; the train still runs.
    const clear = theme.fogFar > 500;
    if (clear) {
      this.buildClouds();
      this.buildPlane();
      if (!theme.night) {
        this.buildBirds();
        this.buildBalloons();
      }
    }
    this.buildTrain();
    this.buildDeer();
    this.buildCrowd();
    this.buildCabins();
  }

  update(dt: number) {
    this.time += dt;
    for (const u of this.updaters) u(dt, this.time);
  }

  // ---------- Deer ----------

  /** A few deer that wander across the road now and then. Hit one and it costs you; they bolt if you do. */
  private buildDeer() {
    const { track, scene } = this.world;
    const rnd = this.rnd;
    const hide = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.9 });
    const pale = new THREE.MeshStandardMaterial({ color: 0xd9c7a8, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.9 });
    let placed = 0;
    let tries = 0;
    while (placed < 3 && tries++ < 200) {
      const i = Math.floor(rnd() * track.n);
      if (track.walled[i] || track.asphalt[i] || track.respawn[i] !== i || i * track.ds < track.startS + 220 || track.hw[i] < 6) continue;
      if (this.world.terrain.iceAt(track.px[i], track.pz[i]) > 0) continue;
      placed++;
      const deer = new THREE.Group();
      const part = (w: number, h: number, l: number, mat: THREE.Material, x: number, y: number, z: number) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
        m.position.set(x, y, z);
        m.castShadow = true;
        deer.add(m);
        return m;
      };
      // Built facing +Z.
      part(0.5, 0.6, 1.4, hide, 0, 1.15, 0);
      part(0.3, 0.7, 0.3, hide, 0, 1.6, 0.75).rotation.x = 0.5;
      part(0.28, 0.3, 0.5, hide, 0, 1.98, 1.02);
      part(0.3, 0.25, 0.12, pale, 0, 1.2, -0.72);
      const legs = [
        part(0.13, 0.9, 0.13, dark, 0.17, 0.45, 0.5),
        part(0.13, 0.9, 0.13, dark, -0.17, 0.45, 0.5),
        part(0.13, 0.9, 0.13, dark, 0.17, 0.45, -0.5),
        part(0.13, 0.9, 0.13, dark, -0.17, 0.45, -0.5),
      ];
      for (const l of legs) l.geometry.translate(0, -0.45, 0), (l.position.y = 0.9);
      for (const side of [1, -1]) {
        part(0.05, 0.5, 0.05, pale, side * 0.14, 2.35, 0.95).rotation.z = -side * 0.5;
        part(0.05, 0.3, 0.05, pale, side * 0.3, 2.55, 0.95).rotation.z = side * 0.3;
      }
      scene.add(deer);

      const reach = track.hw[i] + 14;
      let lat = (rnd() < 0.5 ? -1 : 1) * reach;
      let dir = 0;
      let wait = 3 + rnd() * 12;
      let speed = 3.6;
      const animal = {
        x: 0,
        z: 0,
        onRoad: false,
        scare: () => {
          // Bolt for whichever side is nearer.
          dir = lat >= 0 ? 1 : -1;
          speed = 11;
        },
      };
      this.animals.push(animal);
      this.updaters.push((dt, t) => {
        if (dir === 0) {
          wait -= dt;
          if (wait <= 0) {
            dir = lat > 0 ? -1 : 1;
            speed = 3.6;
          }
        } else {
          lat += dir * speed * dt;
          if (Math.abs(lat) >= reach) {
            lat = Math.sign(lat) * reach;
            dir = 0;
            wait = 8 + rnd() * 16;
          }
        }
        animal.x = track.px[i] + track.lx[i] * lat;
        animal.z = track.pz[i] + track.lz[i] * lat;
        animal.onRoad = Math.abs(lat) < track.hw[i] + 1;
        deer.position.set(animal.x, this.world.terrain.height(animal.x, animal.z), animal.z);
        // Face the way it is walking (or last walked): across the road.
        const face = (dir !== 0 ? dir : lat > 0 ? 1 : -1) > 0 ? 1 : -1;
        deer.rotation.y = Math.atan2(track.lx[i] * face, track.lz[i] * face);
        const stride = dir !== 0 ? Math.sin(t * speed * 2.6) * 0.5 : 0;
        legs[0].rotation.x = legs[3].rotation.x = stride;
        legs[1].rotation.x = legs[2].rotation.x = -stride;
      });
    }
  }

  // ---------- Spectators at the start ----------

  private buildCrowd() {
    const { track, terrain, scene } = this.world;
    const rnd = this.rnd;
    const spots: [number, number, number][] = [];
    const a = track.startIdx;
    for (let k = -14; k <= 26; k++) {
      const i = track.wrap(a + k);
      if (track.walled[i]) continue;
      for (const side of [1, -1]) {
        for (let row = 0; row < 2; row++) {
          if (rnd() < 0.3) continue;
          const off = side * (track.hw[i] + 3.2 + row * 1.5 + rnd() * 0.6);
          const x = track.px[i] + track.lx[i] * off + (rnd() - 0.5) * 0.8;
          const z = track.pz[i] + track.lz[i] * off + (rnd() - 0.5) * 0.8;
          spots.push([x, terrain.height(x, z), z]);
        }
      }
    }
    if (!spots.length) return;
    const body = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.24, 0.85, 3, 8), new THREE.MeshStandardMaterial({ roughness: 0.85 }), spots.length);
    const head = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 8, 6), new THREE.MeshStandardMaterial({ color: 0xe2b99a, roughness: 0.8 }), spots.length);
    const coats = [0xd8343a, 0x1e6fb0, 0xf6a821, 0x2e9e5b, 0xf3f6f8, 0x13b5c2, 0xff6f3c, 0x34495e];
    const m = new THREE.Matrix4();
    const tint = new THREE.Color();
    const phases = spots.map(() => rnd() * 6);
    const jumpy = spots.map(() => rnd() < 0.5);
    spots.forEach((_s, j) => body.setColorAt(j, tint.setHex(coats[Math.floor(rnd() * coats.length)])));
    body.castShadow = true;
    body.frustumCulled = head.frustumCulled = false;
    scene.add(body, head);
    // Half the crowd bounces on the spot, cheering.
    this.updaters.push((_dt, t) => {
      spots.forEach(([x, y, z], j) => {
        const hop = jumpy[j] ? Math.abs(Math.sin(t * 5 + phases[j])) * 0.22 : 0;
        body.setMatrixAt(j, m.makeTranslation(x, y + 0.67 + hop, z));
        head.setMatrixAt(j, m.makeTranslation(x, y + 1.5 + hop, z));
      });
      body.instanceMatrix.needsUpdate = true;
      head.instanceMatrix.needsUpdate = true;
    });
  }

  // ---------- Cabins ----------

  private buildCabins() {
    const { terrain, scene, theme, colliders } = this.world;
    const rnd = this.rnd;
    const logs = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: theme.meadow ? 0x5b3a2a : 0xeef3f7, roughness: 0.9 });
    const glow = new THREE.MeshStandardMaterial({ color: 0xffe9b0, emissive: 0xffb84a, emissiveIntensity: theme.night ? 2.4 : 0.9 });
    const stone = new THREE.MeshStandardMaterial({ color: 0x5d6068, roughness: 1 });
    // A roof is a prism: a triangle pushed along the cabin's length.
    const gable = new THREE.Shape();
    gable.moveTo(-3.3, 0);
    gable.lineTo(0, 2.1);
    gable.lineTo(3.3, 0);
    gable.closePath();
    const roofGeo = new THREE.ExtrudeGeometry(gable, { depth: 6.6, bevelEnabled: false }).translate(0, 0, -3.3);
    let placed = 0;
    let tries = 0;
    while (placed < 5 && tries++ < 400) {
      const x = terrain.minX + rnd() * terrain.sizeX;
      const z = terrain.minZ + rnd() * terrain.sizeZ;
      const d = terrain.edgeAt(x, z);
      if (d < 16 || d > 70 || terrain.wetAt(x, z) > 0 || terrain.iceAt(x, z) > 0) continue;
      const n = terrain.normal(x, z, new THREE.Vector3());
      if (n.y < 0.93) continue;
      placed++;
      const cabin = new THREE.Group();
      const add = (geo: THREE.BufferGeometry, mat: THREE.Material, px: number, py: number, pz: number) => {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(px, py, pz);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        cabin.add(mesh);
      };
      add(new THREE.BoxGeometry(5.6, 2.8, 6), logs, 0, 1.4, 0);
      add(roofGeo, roofMat, 0, 2.8, 0);
      add(new THREE.BoxGeometry(1.1, 1.9, 0.12), new THREE.MeshStandardMaterial({ color: 0x3a2618, roughness: 0.9 }), 0, 0.95, 3.02);
      for (const side of [1, -1]) {
        add(new THREE.BoxGeometry(0.9, 0.8, 0.1), glow, side * 1.7, 1.6, 3.03);
        add(new THREE.BoxGeometry(0.1, 0.8, 1.1), glow, side * 2.83, 1.6, 0);
      }
      add(new THREE.BoxGeometry(0.8, 1.9, 0.8), stone, 1.6, 4.1, -1.4);
      cabin.position.set(x, terrain.height(x, z) - 0.25, z);
      cabin.rotation.y = rnd() * Math.PI * 2;
      scene.add(cabin);
      colliders.add({ x, z, r: 4.2 });
    }
  }

  // ---------- Clouds ----------

  private buildClouds() {
    const { theme } = this.world;
    const rnd = this.rnd;
    const count = 18;
    const puffs: { cloud: number; off: THREE.Vector3; scale: THREE.Vector3 }[] = [];
    const clouds: { x: number; y: number; z: number; speed: number }[] = [];
    const spanX = this.rx + 900;
    for (let c = 0; c < count; c++) {
      clouds.push({
        x: this.cx + (rnd() * 2 - 1) * spanX,
        y: this.top + 190 + rnd() * 200,
        z: this.cz + (rnd() * 2 - 1) * (this.rz + 700),
        speed: 3 + rnd() * 4,
      });
      const n = 5 + Math.floor(rnd() * 4);
      const size = 22 + rnd() * 26;
      for (let k = 0; k < n; k++) {
        const s = size * (0.55 + rnd() * 0.6);
        puffs.push({
          cloud: c,
          off: new THREE.Vector3((rnd() - 0.5) * size * 2.6, (rnd() - 0.3) * size * 0.35, (rnd() - 0.5) * size * 1.2),
          scale: new THREE.Vector3(s, s * 0.55, s * 0.8),
        });
      }
    }
    const color = theme.night ? 0x33465c : new THREE.Color(0xffffff).lerp(new THREE.Color(theme.skyHorizon), 0.25).getHex();
    const mesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 2),
      // A little self-light keeps the undersides from picking up the colour of the ground.
      new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: theme.night ? 0.1 : 0.35, fog: false, transparent: true, opacity: theme.night ? 0.75 : 0.94 }),
      puffs.length,
    );
    mesh.frustumCulled = false;
    this.world.scene.add(mesh);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    this.updaters.push((dt) => {
      for (const c of clouds) {
        c.x += c.speed * dt;
        if (c.x > this.cx + spanX) c.x -= spanX * 2;
      }
      puffs.forEach((puff, i) => {
        const c = clouds[puff.cloud];
        p.set(c.x + puff.off.x, c.y + puff.off.y, c.z + puff.off.z);
        mesh.setMatrixAt(i, m.compose(p, q, puff.scale));
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
  }

  // ---------- Birds ----------

  private buildBirds() {
    const { track, scene } = this.world;
    const rnd = this.rnd;
    // One wing: a thin triangle from the body out to the tip. The other is its mirror.
    const wing = new THREE.BufferGeometry();
    wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.35, 0, 0, -0.45, 1.5, 0, -0.15], 3));
    wing.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: 0x20262d, side: THREE.DoubleSide });

    for (let f = 0; f < 4; f++) {
      const i = Math.floor(rnd() * track.n);
      const side = rnd() < 0.5 ? 1 : -1;
      const ax = track.px[i] + track.lx[i] * side * (30 + rnd() * 50);
      const az = track.pz[i] + track.lz[i] * side * (30 + rnd() * 50);
      const ay = track.py[i] + 28 + rnd() * 40;
      const radius = 45 + rnd() * 60;
      const turn = (0.12 + rnd() * 0.1) * (rnd() < 0.5 ? 1 : -1);
      const start = rnd() * 6;
      const birds: { node: THREE.Group; wings: THREE.Mesh[]; back: number; out: number; phase: number }[] = [];
      const size = 6 + Math.floor(rnd() * 5);
      for (let b = 0; b < size; b++) {
        const node = new THREE.Group();
        const l = new THREE.Mesh(wing, mat);
        const r = new THREE.Mesh(wing, mat);
        r.scale.x = -1;
        node.add(l, r);
        scene.add(node);
        // V formation: each bird behind and outboard of the one ahead.
        const rank = Math.ceil(b / 2);
        birds.push({ node, wings: [l, r], back: rank * 3.2, out: (b % 2 ? 1 : -1) * rank * 2.6, phase: rnd() * 6 });
      }
      this.updaters.push((_dt, t) => {
        const a = start + t * turn;
        const dir = Math.sign(turn);
        // Heading is the tangent of the circle.
        const hx = -Math.sin(a) * dir;
        const hz = Math.cos(a) * dir;
        const lx = ax + Math.cos(a) * radius;
        const lz = az + Math.sin(a) * radius;
        for (const b of birds) {
          b.node.position.set(lx - hx * b.back + hz * b.out, ay + Math.sin(t * 0.7 + b.phase) * 1.5, lz - hz * b.back - hx * b.out);
          b.node.rotation.y = Math.atan2(hx, hz);
          const flap = Math.sin(t * 7 + b.phase) * 0.55;
          b.wings[0].rotation.z = flap;
          b.wings[1].rotation.z = -flap;
        }
      });
    }
  }

  // ---------- Hot-air balloons ----------

  private buildBalloons() {
    const { scene, terrain } = this.world;
    const rnd = this.rnd;
    const schemes: [number, number][] = [
      [0xd8343a, 0xf3f6f8],
      [0xf6a821, 0x1e6fb0],
      [0x2e9e5b, 0xf3f6f8],
    ];
    for (const [c1, c2] of schemes) {
      const envelope = new THREE.SphereGeometry(9, 16, 12);
      const p = envelope.attributes.position;
      const col = new Float32Array(p.count * 3);
      const a = new THREE.Color(c1);
      const b = new THREE.Color(c2);
      for (let i = 0; i < p.count; i++) {
        // Vertical gores in two colours, and a taper toward the basket.
        const gore = Math.floor(((Math.atan2(p.getZ(i), p.getX(i)) + Math.PI) / (Math.PI * 2)) * 8) % 2;
        const c = gore ? a : b;
        col.set([c.r, c.g, c.b], i * 3);
        const y = p.getY(i);
        if (y < 0) {
          const k = 1 + (y / 9) * 0.55;
          p.setX(i, p.getX(i) * k);
          p.setZ(i, p.getZ(i) * k);
          p.setY(i, y * 1.25);
        }
      }
      envelope.setAttribute('color', new THREE.BufferAttribute(col, 3));
      envelope.computeVertexNormals();
      const balloon = new THREE.Group();
      balloon.add(new THREE.Mesh(envelope, new THREE.MeshLambertMaterial({ vertexColors: true, fog: false })));
      const basket = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.8, 2.4), new THREE.MeshLambertMaterial({ color: 0x6b4a2b, fog: false }));
      basket.position.y = -14.5;
      balloon.add(basket);
      scene.add(balloon);

      const x = this.cx + (rnd() * 2 - 1) * this.rx * 0.8;
      const z = this.cz + (rnd() * 2 - 1) * this.rz * 0.8;
      const y = Math.max(terrain.height(x, z), this.top) + 70 + rnd() * 70;
      const phase = rnd() * 6;
      const drift = 14 + rnd() * 18;
      this.updaters.push((_dt, t) => {
        balloon.position.set(x + Math.sin(t * 0.03 + phase) * drift, y + Math.sin(t * 0.25 + phase) * 3, z + Math.cos(t * 0.024 + phase) * drift);
        balloon.rotation.y = t * 0.05 + phase;
      });
    }
  }

  // ---------- Airliner ----------

  private buildPlane() {
    const { scene, theme } = this.world;
    const rnd = this.rnd;
    const white = new THREE.MeshLambertMaterial({ color: theme.night ? 0x8fa3b8 : 0xf4f7fa, fog: false });
    const blue = new THREE.MeshLambertMaterial({ color: 0x1e5f9e, fog: false });
    const plane = new THREE.Group();
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      plane.add(mesh);
      return mesh;
    };
    // Built nose toward +Z.
    add(new THREE.CylinderGeometry(2.3, 2.3, 34, 10).rotateX(Math.PI / 2), white, 0, 0, 0);
    add(new THREE.ConeGeometry(2.3, 6, 10).rotateX(Math.PI / 2), white, 0, 0, 20);
    add(new THREE.ConeGeometry(2.3, 9, 10).rotateX(-Math.PI / 2), white, 0, 0.6, -21);
    add(new THREE.BoxGeometry(40, 0.6, 6.5), white, 0, -0.8, 1).rotation.y = 0;
    add(new THREE.BoxGeometry(14, 0.5, 3.6), white, 0, 1, -19);
    add(new THREE.BoxGeometry(0.6, 7, 5), blue, 0, 4, -19.5);
    for (const side of [1, -1]) add(new THREE.CylinderGeometry(1.2, 1.2, 5, 8).rotateX(Math.PI / 2), blue, side * 9, -2.2, 3);
    if (theme.night) {
      const beacon = add(new THREE.SphereGeometry(1.1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3030, fog: false }), 0, -2.6, 0);
      this.updaters.push((_dt, t) => (beacon.visible = t % 1.2 < 0.25));
    }
    // Contrail: a long strip that fades out behind.
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 256;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 8, 256);
    const trail = add(
      new THREE.PlaneGeometry(5, 700).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, opacity: theme.night ? 0.25 : 0.8 }),
      0,
      0,
      -372,
    );
    trail.rotation.y = Math.PI;
    plane.scale.setScalar(1.6);
    plane.visible = false;
    scene.add(plane);

    // One pass every minute or so, each on a fresh line across the map.
    const reach = Math.hypot(this.rx, this.rz) + 1500;
    const speed = 95;
    const passTime = (reach * 2) / speed;
    let wait = 6 + rnd() * 10;
    let flying = 0;
    let heading = 0;
    let offset = 0;
    this.updaters.push((dt) => {
      if (flying <= 0) {
        wait -= dt;
        if (wait > 0) return;
        heading = rnd() * Math.PI * 2;
        offset = (rnd() - 0.5) * Math.min(this.rx, this.rz);
        flying = passTime;
        plane.visible = true;
        plane.rotation.y = heading;
      }
      flying -= dt;
      const d = (1 - flying / passTime) * reach * 2 - reach;
      const hx = Math.sin(heading);
      const hz = Math.cos(heading);
      plane.position.set(this.cx + hx * d + hz * offset, this.top + 520, this.cz + hz * d - hx * offset);
      if (flying <= 0) {
        plane.visible = false;
        wait = 35 + rnd() * 40;
      }
    });
  }

  // ---------- Steam train ----------

  private buildTrain() {
    const { track, terrain, scene, theme } = this.world;
    const rnd = this.rnd;

    // Find a stretch of mountainside beside the course where a railway can run clear of it.
    const span = Math.min(track.n - 1, Math.round(760 / track.ds));
    const stepN = 4;
    let best: { x: number[]; z: number[] } | null = null;
    let bestClear = 44;
    for (const side of [1, -1]) {
      for (let k = 0; k < 12; k++) {
        const s0 = Math.floor((k / 12) * track.n);
        if (!track.closed && s0 + span >= track.n) continue;
        const rawX: number[] = [];
        const rawZ: number[] = [];
        for (let j = 0; j <= span; j += stepN) {
          const i = track.wrap(s0 + j);
          const off = side * (track.hw[i] + 92);
          rawX.push(track.px[i] + track.lx[i] * off);
          rawZ.push(track.pz[i] + track.lz[i] * off);
        }
        // Railways don't do sharp bends: average the line out.
        const x = smooth(smooth(rawX, 7), 7);
        const z = smooth(smooth(rawZ, 7), 7);
        let clear = Infinity;
        for (let j = 0; j < x.length; j++) {
          const inside =
            x[j] > terrain.minX + 20 && x[j] < terrain.minX + terrain.sizeX - 20 && z[j] > terrain.minZ + 20 && z[j] < terrain.minZ + terrain.sizeZ - 20;
          const wet = terrain.wetAt(x[j], z[j]) > 0 || terrain.iceAt(x[j], z[j]) > 0;
          clear = Math.min(clear, inside && !wet ? terrain.edgeAt(x[j], z[j]) : 0);
        }
        if (clear > bestClear) {
          bestClear = clear;
          best = { x, z };
        }
      }
    }
    if (!best) return;

    const { x, z } = best;
    // The line keeps an even grade, so it cuts through rises and bridges dips.
    const y = smooth(smooth(x.map((px, j) => terrain.height(px, z[j]) + 1.6), 6), 6);
    const cum = [0];
    for (let j = 1; j < x.length; j++) cum.push(cum[j - 1] + Math.hypot(x[j] - x[j - 1], y[j] - y[j - 1], z[j] - z[j - 1]));
    const length = cum[cum.length - 1];
    const last = x.length - 1;
    const at = (d: number, out: THREE.Vector3): THREE.Vector3 => {
      // Past either end the line carries straight on, into the rock.
      if (d < 0 || d > length) {
        const [e, f] = d < 0 ? [0, 1] : [last, last - 1];
        const over = d < 0 ? -d : d - length;
        const seg = Math.hypot(x[e] - x[f], z[e] - z[f]) || 1;
        return out.set(x[e] + ((x[e] - x[f]) / seg) * over, y[e], z[e] + ((z[e] - z[f]) / seg) * over);
      }
      const dd = d;
      let j = 0;
      while (j < cum.length - 2 && cum[j + 1] < dd) j++;
      const u = (dd - cum[j]) / (cum[j + 1] - cum[j] || 1);
      return out.set(x[j] + (x[j + 1] - x[j]) * u, y[j] + (y[j + 1] - y[j]) * u, z[j] + (z[j + 1] - z[j]) * u);
    };

    // Track bed, rails, and stone piers where the line leaves the ground.
    const ribbon = (half: number, dy: number, mat: THREE.Material) => {
      const pos: number[] = [];
      const idx: number[] = [];
      for (let j = 0; j < x.length; j++) {
        const a = Math.max(0, j - 1);
        const b = Math.min(x.length - 1, j + 1);
        const tx = x[b] - x[a];
        const tz = z[b] - z[a];
        const l = Math.hypot(tx, tz) || 1;
        pos.push(x[j] + (tz / l) * half, y[j] + dy, z[j] - (tx / l) * half, x[j] - (tz / l) * half, y[j] + dy, z[j] + (tx / l) * half);
        if (j > 0) idx.push(j * 2 - 2, j * 2 - 1, j * 2, j * 2, j * 2 - 1, j * 2 + 1);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      scene.add(mesh);
    };
    const stone = new THREE.MeshStandardMaterial({ color: 0x6a665f, roughness: 0.95 });
    ribbon(2.1, -0.35, new THREE.MeshStandardMaterial({ color: 0x4a4540, roughness: 1, side: THREE.DoubleSide }));
    ribbon(0.9, -0.2, new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.4, metalness: 0.7, side: THREE.DoubleSide }));
    ribbon(0.7, -0.19, new THREE.MeshStandardMaterial({ color: 0x4a4540, roughness: 1, side: THREE.DoubleSide }));
    for (let j = 1; j < x.length - 1; j += 2) {
      const ground = terrain.height(x[j], z[j]);
      const h = y[j] - 0.4 - ground;
      if (h < 2) continue;
      const pier = new THREE.Mesh(new THREE.BoxGeometry(2.2, h + 1, 2.2), stone);
      pier.position.set(x[j], ground + (h - 1) / 2, z[j]);
      pier.castShadow = true;
      scene.add(pier);
    }
    // A tunnel mouth at each end for the train to come out of and vanish into.
    const p = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    const rockMat = new THREE.MeshStandardMaterial({ color: theme.meadow ? 0x8a8273 : 0x5d646d, roughness: 0.95, flatShading: true });
    const hole = new THREE.MeshBasicMaterial({ color: 0x05070a });
    for (const d of [0, length]) {
      // A rock outcrop the line runs into, with a black portal in its face.
      const mouth = new THREE.Group();
      at(d, p);
      at(d === 0 ? 4 : length - 4, p2);
      mouth.position.copy(p);
      mouth.lookAt(p2.x, p.y, p2.z);
      const lumps: [number, number, number, number, number, number][] = [
        [0, 3, -13, 11, 9, 12],
        [-7, 2, -9, 7, 7, 8],
        [7, 2.5, -10, 7.5, 8, 9],
        [0, 8, -8, 8, 4.5, 7],
      ];
      for (const [lx, ly, lz, sx, sy, sz] of lumps) {
        const rock = new THREE.Mesh(rockGeo, rockMat);
        rock.position.set(lx, ly, lz);
        rock.scale.set(sx, sy, sz);
        rock.rotation.set(lx * 0.3, lz * 0.7, sy);
        rock.castShadow = true;
        mouth.add(rock);
      }
      const portal = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.1, 14, 14, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2), hole);
      portal.position.set(0, 0.2, -5);
      portal.scale.y = 1.35;
      mouth.add(portal);
      scene.add(mouth);
    }

    // Rolling stock, each built with its front toward +Z.
    const black = new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.6, metalness: 0.4 });
    const red = new THREE.MeshStandardMaterial({ color: 0x8f2227, roughness: 0.6 });
    const glow = new THREE.MeshStandardMaterial({ color: 0xffe9b0, emissive: 0xffc56b, emissiveIntensity: theme.night ? 2.2 : 0.5 });
    const box = (parent: THREE.Object3D, w: number, h: number, l: number, mat: THREE.Material, px: number, py: number, pz: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
      mesh.position.set(px, py, pz);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const wheels = (parent: THREE.Object3D, zs: number[], r: number) => {
      for (const wz of zs) {
        for (const side of [1, -1]) {
          const w = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.25, 12).rotateZ(Math.PI / 2), black);
          w.position.set(side * 1.0, r, wz);
          parent.add(w);
        }
      }
    };
    const loco = new THREE.Group();
    const boiler = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 5.6, 14).rotateX(Math.PI / 2), black);
    boiler.position.set(0, 2.25, 1.2);
    boiler.castShadow = true;
    loco.add(boiler);
    box(loco, 2.7, 2.9, 2.6, red, 0, 2.7, -2.9);
    box(loco, 3.0, 0.2, 3.0, black, 0, 4.2, -2.9);
    box(loco, 2.3, 0.5, 8.4, black, 0, 1.05, 0);
    const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.3, 1.5, 10), black);
    chimney.position.set(0, 4.0, 3.1);
    loco.add(chimney);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), red);
    dome.position.set(0, 3.45, 1.2);
    loco.add(dome);
    box(loco, 0.5, 0.5, 0.2, glow, 0, 2.6, 4.05);
    const cow = new THREE.Mesh(new THREE.ConeGeometry(1.3, 1.6, 4).rotateX(Math.PI / 2), red);
    cow.position.set(0, 0.7, 4.6);
    cow.scale.y = 0.6;
    loco.add(cow);
    wheels(loco, [-2.8, -0.6, 1.2, 3.0], 0.75);

    const cars: { node: THREE.Group; back: number }[] = [{ node: loco, back: 0 }];
    const tender = new THREE.Group();
    box(tender, 2.5, 2.1, 4.2, black, 0, 2.0, 0);
    wheels(tender, [-1.3, 1.3], 0.6);
    cars.push({ node: tender, back: 7.6 });
    const liveries = [0x1e6fb0, 0x2e8b57, 0xc9a227, 0xb0452c, 0x1e6fb0];
    liveries.forEach((color, k) => {
      const car = new THREE.Group();
      box(car, 2.7, 2.7, 9, new THREE.MeshStandardMaterial({ color, roughness: 0.6 }), 0, 2.45, 0);
      box(car, 2.95, 0.3, 9.3, new THREE.MeshStandardMaterial({ color: 0x2b3037, roughness: 0.8 }), 0, 3.95, 0);
      // Lit windows down both sides.
      for (const side of [1, -1]) box(car, 0.06, 0.8, 7.6, glow, side * 1.37, 2.9, 0);
      wheels(car, [-3.2, -2.2, 2.2, 3.2], 0.55);
      cars.push({ node: car, back: 13.8 + k * 10.2 });
    });
    for (const c of cars) {
      c.node.visible = false;
      scene.add(c.node);
    }

    // Smoke from the chimney.
    const puffCount = 70;
    const puffs = new Float32Array(puffCount * 3).fill(-1e5);
    const puffVel = new Float32Array(puffCount * 3);
    const puffLife = new Float32Array(puffCount);
    const smokeGeo = new THREE.BufferGeometry();
    smokeGeo.setAttribute('position', new THREE.BufferAttribute(puffs, 3));
    const smoke = new THREE.Points(
      smokeGeo,
      new THREE.PointsMaterial({ color: theme.night ? 0x8a94a0 : 0xe8eaec, size: 7, map: softDot(), transparent: true, opacity: 0.5, depthWrite: false }),
    );
    smoke.frustumCulled = false;
    scene.add(smoke);
    let nextPuff = 0;
    let puffTimer = 0;

    const speed = 15;
    const trainLength = cars[cars.length - 1].back + 6;
    let head = rnd() * length;
    let pause = 0;
    this.updaters.push((dt) => {
      if (pause > 0) {
        pause -= dt;
        if (pause <= 0) head = -9;
      } else {
        head += speed * dt;
        // Once the last carriage is in the far tunnel, wait a while and start again.
        if (head - trainLength > length + 10) pause = 5 + rnd() * 8;
      }
      for (const c of cars) {
        const d = head - c.back;
        c.node.visible = pause <= 0 && d > -9 && d < length + 9;
        if (!c.node.visible) continue;
        at(d, p);
        at(d + 3, p2);
        c.node.position.copy(p);
        c.node.lookAt(p2);
      }
      puffTimer -= dt;
      if (loco.visible && puffTimer <= 0) {
        puffTimer = 0.11;
        chimney.getWorldPosition(p);
        const k = nextPuff * 3;
        nextPuff = (nextPuff + 1) % puffCount;
        puffs[k] = p.x;
        puffs[k + 1] = p.y + 0.9;
        puffs[k + 2] = p.z;
        puffVel[k] = 1.2 + (Math.random() - 0.5) * 1.5;
        puffVel[k + 1] = 3.2 + Math.random() * 1.5;
        puffVel[k + 2] = (Math.random() - 0.5) * 1.5;
        puffLife[k / 3] = 6;
      }
      for (let i = 0; i < puffCount; i++) {
        if (puffLife[i] <= 0) continue;
        puffLife[i] -= dt;
        const k = i * 3;
        if (puffLife[i] <= 0) {
          puffs[k + 1] = -1e5;
          continue;
        }
        puffs[k] += puffVel[k] * dt;
        puffs[k + 1] += puffVel[k + 1] * dt;
        puffs[k + 2] += puffVel[k + 2] * dt;
        // Smoke slows as it rises.
        puffVel[k + 1] *= 1 - 0.25 * dt;
      }
      smokeGeo.attributes.position.needsUpdate = true;
    });
  }
}

/** Moving average over a window of ±r entries, shrinking at the ends. */
function smooth(v: number[], r: number) {
  return v.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(v.length - 1, i + r); k++) {
      sum += v[k];
      n++;
    }
    return sum / n;
  });
}
