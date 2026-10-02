import * as THREE from 'three';
import type { World } from './world';
import type { Sled } from './sled';

/** Step heights for first, second and third, and where each stands across the podium. */
const STEPS = [
  { x: 0, h: 1.5 },
  { x: -3.7, h: 1.0 },
  { x: 3.7, h: 0.65 },
];
const CONFETTI = 520;
const CONFETTI_COLORS = [0xf6a821, 0x1ea7e1, 0xffffff, 0x2fbf71, 0xe5484d, 0xffd66b];

function label(text: string, w: number, h: number, font: string, fg: string, bg: string) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + h * 0.04);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The prize-giving: a three-step podium on the finish line with the top
 * three sleds parked on it, a backdrop behind and confetti coming down.
 */
export class Podium {
  readonly group = new THREE.Group();
  private bits: THREE.Points;
  private fall = new Float32Array(CONFETTI);
  private centre = new THREE.Vector3();
  private t = 0;

  constructor(
    private world: World,
    /** First, second and third, in that order. Fewer is fine. */
    winners: Sled[],
  ) {
    const { track } = world;
    const i = track.finishIdx;
    const y = world.ground(track.px[i], track.pz[i], i);
    this.centre.set(track.px[i], y, track.pz[i]);
    this.group.position.copy(this.centre);
    // The podium faces back up the course, toward the riders still coming in.
    this.group.rotation.y = Math.atan2(-track.tx[i], -track.tz[i]);

    const navy = new THREE.MeshStandardMaterial({ color: 0x12283d, roughness: 0.7 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xf6a821, roughness: 0.5 });
    STEPS.forEach((s, k) => {
      // Sunk well into the ground, so a slope never shows daylight underneath.
      const block = new THREE.Mesh(new THREE.BoxGeometry(3.5, s.h + 4, 4.4), navy);
      block.position.set(s.x, s.h / 2 - 2, 0);
      block.castShadow = block.receiveShadow = true;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.1, 4.5), trim);
      cap.position.set(s.x, s.h, 0);
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(1.1, Math.min(1.1, s.h * 0.85)),
        new THREE.MeshBasicMaterial({ map: label(String(k + 1), 128, 128, '900 104px "Segoe UI", Arial, sans-serif', '#12283d', '#f6a821') }),
      );
      plate.position.set(s.x, s.h * 0.5, 2.21);
      this.group.add(block, cap, plate);
    });

    // Backdrop board on two posts.
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(13, 3.2),
      new THREE.MeshBasicMaterial({ map: label('POWDER RUSH', 1024, 256, 'italic 900 150px "Segoe UI", Arial, sans-serif', '#f3f8fc', '#0d2032'), side: THREE.DoubleSide }),
    );
    board.position.set(0, 4.3, -3.2);
    this.group.add(board);
    for (const x of [-6.3, 6.3]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 9, 8), trim);
      post.position.set(x, 1.5, -3.2);
      this.group.add(post);
    }
    // A night race needs the lights on.
    if (world.theme.night) {
      const lamp = new THREE.PointLight(0xfff0cf, 260, 45, 1.4);
      lamp.position.set(0, 6, 7);
      this.group.add(lamp);
    }

    // Confetti.
    const pos = new Float32Array(CONFETTI * 3);
    const col = new Float32Array(CONFETTI * 3);
    const c = new THREE.Color();
    for (let k = 0; k < CONFETTI; k++) {
      pos[k * 3] = (Math.random() - 0.5) * 18;
      pos[k * 3 + 1] = Math.random() * 10;
      pos[k * 3 + 2] = (Math.random() - 0.5) * 12 + 2;
      this.fall[k] = 1.3 + Math.random() * 1.8;
      c.setHex(CONFETTI_COLORS[k % CONFETTI_COLORS.length]).toArray(col, k * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.bits = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.17, vertexColors: true, fog: false }));
    this.bits.frustumCulled = false;
    this.group.add(this.bits);

    world.scene.add(this.group);
    this.group.updateMatrixWorld(true);

    // Park the winners on their steps, facing the camera.
    winners.slice(0, 3).forEach((s, k) => {
      const g = s.model.group;
      g.position.set(STEPS[k].x, STEPS[k].h + 0.05, 0).applyMatrix4(this.group.matrixWorld);
      g.quaternion.copy(this.group.quaternion);
      g.visible = true;
    });
  }

  /** Confetti falls and the camera drifts across the front of the podium. */
  update(dt: number, camera: THREE.PerspectiveCamera) {
    this.t += dt;
    const p = this.bits.geometry.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < CONFETTI; k++) {
      let y = p.getY(k) - this.fall[k] * dt;
      if (y < 0) y += 10;
      p.setY(k, y);
      p.setX(k, p.getX(k) + Math.sin(this.t * 2 + k) * 0.6 * dt);
    }
    p.needsUpdate = true;

    const swing = Math.sin(this.t * 0.35) * 0.55;
    const dist = 14.5 - Math.min(4, this.t * 0.8);
    _v.set(Math.sin(swing) * dist, 3.1, Math.cos(swing) * dist).applyMatrix4(this.group.matrixWorld);
    // Never under the snow, whatever the slope.
    _v.y = Math.max(_v.y, this.world.ground(_v.x, _v.z, this.world.track.finishIdx) + 1.4);
    camera.up.set(0, 1, 0);
    camera.position.copy(_v);
    camera.fov = 46;
    camera.updateProjectionMatrix();
    camera.lookAt(this.centre.x, this.centre.y + 1.9, this.centre.z);
  }

  dispose() {
    this.world.scene.remove(this.group);
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | undefined;
      if (!mat) return;
      (mat as THREE.MeshBasicMaterial).map?.dispose();
      mat.dispose();
    });
  }
}

const _v = new THREE.Vector3();
