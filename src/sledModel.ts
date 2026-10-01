import * as THREE from 'three';
import { DEFAULT_SLED, SledShape } from './sleds';

interface Strut {
  /** Mount on the sprung body, in body coordinates. */
  top: THREE.Vector3;
  /** Mount on the unsprung part (ski carrier or track frame), before that part's travel is added. */
  bottom: THREE.Vector3;
  /** Which ski carrier the bottom rides on: 0 left, 1 right, -1 the fixed track frame. */
  ski: number;
  /** Whole strut, aimed from top to bottom each frame. */
  node: THREE.Object3D;
  /** Parts that stretch with the strut's length (the coil spring, the damper rod, a wishbone). */
  stretch: THREE.Object3D[];
}

export interface SledModel {
  group: THREE.Group;
  /** Sprung mass: hull, seat, rider. Rides up and down on the suspension. */
  body: THREE.Group;
  rider: THREE.Group;
  /** Ski carriers move up and down with the terrain; the pivots inside them steer. */
  skiCarriers: THREE.Group[];
  skis: THREE.Group[];
  struts: Strut[];
}

const Y = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();

/** A unit-length coil spring hanging down from the origin; scale Y to its real length. */
function coilGeometry() {
  const pts: THREE.Vector3[] = [];
  const turns = 7;
  for (let i = 0; i <= turns * 12; i++) {
    const t = i / (turns * 12);
    const a = t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * 0.06, -t, Math.sin(a) * 0.06));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), turns * 12, 0.014, 5);
}

/** Builds a snowmobile and rider from primitives. Faces +Z, origin on the snow. */
export function buildSledModel(color: number, helmet: number, shape: SledShape = DEFAULT_SLED.shape): SledModel {
  const group = new THREE.Group();
  const body = new THREE.Group();
  const rider = new THREE.Group();
  group.add(body);
  // The body is built at standard size and stretched to the model's proportions; the rider stays human-sized.
  body.scale.set(shape.width, shape.height, shape.length);
  rider.scale.set(1 / shape.width, 1 / shape.height, 1 / shape.length);
  // Nose reach and droop, in the body's own (unstretched) units.
  const nx = shape.nose / shape.length;
  const tipY = 0.7 - 0.28 * shape.droop;
  const hoodY = 0.86 - 0.1 * shape.droop;

  const base = new THREE.Color(color);
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.35 });
  const paintDark = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.45), roughness: 0.5, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.85 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0c0e11, roughness: 0.95 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xb4bdc6, roughness: 0.3, metalness: 0.85 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xf3f8fc, roughness: 0.5 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: shape.stripe, roughness: 0.5 });
  // Springs stand out against the paint.
  const hue = base.getHSL({ h: 0, s: 0, l: 0 }).h;
  const reddish = hue < 0.06 || hue > 0.94;
  const springMat = new THREE.MeshStandardMaterial({ color: reddish ? 0xffd23a : 0xe5343a, roughness: 0.4, metalness: 0.4 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = body) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  /** A rod between two points. */
  const limb = (a: [number, number, number], b: [number, number, number], r: number, mat: THREE.Material, parent: THREE.Object3D) => {
    _a.set(...a);
    _b.set(...b);
    const len = _a.distanceTo(_b);
    const mesh = add(new THREE.CapsuleGeometry(r, len, 3, 8), mat, 0, 0, 0, parent);
    mesh.position.copy(_a).add(_b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(Y, _d.copy(_b).sub(_a).normalize());
    return mesh;
  };
  const extrudeAcross = (shape: THREE.Shape, width: number, bevel: number) => {
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: width - bevel * 2,
      bevelEnabled: bevel > 0,
      bevelSize: bevel,
      bevelThickness: bevel,
      bevelSegments: 3,
    });
    // The profile is drawn side-on (x = forward, y = up); turn it to run along Z and centre it.
    g.rotateY(-Math.PI / 2);
    g.translate(width / 2 - bevel, 0, 0);
    return g;
  };

  // ---------- Sprung body ----------

  const profile = new THREE.Shape();
  profile.moveTo(-1.3, 0.36);
  profile.lineTo(-1.38, 0.5);
  profile.lineTo(-1.3, 0.62);
  profile.lineTo(-0.25, 0.62);
  profile.quadraticCurveTo(-0.05, 0.66, 0.05, 0.8);
  profile.quadraticCurveTo(0.3, 0.93, 0.6, 0.88);
  profile.quadraticCurveTo(1.05 + nx * 0.6, hoodY, 1.3 + nx, tipY + 0.1);
  profile.quadraticCurveTo(1.4 + nx, tipY, 1.3 + nx, 0.36);
  profile.lineTo(0.95, 0.27);
  profile.lineTo(-0.2, 0.25);
  profile.closePath();
  add(extrudeAcross(profile, 0.74, 0.07), paint, 0, 0, 0);

  // Belly pan and a dark waistline.
  add(new THREE.BoxGeometry(0.66, 0.1, 1.5), dark, 0, 0.27, 0.35);
  // Hood stripe and side vents.
  const stripe = new THREE.Shape();
  stripe.moveTo(0.1, 0.84);
  stripe.quadraticCurveTo(0.3, 0.955, 0.6, 0.905);
  stripe.quadraticCurveTo(1.03 + nx * 0.6, hoodY + 0.02, 1.26 + nx, tipY + 0.14);
  stripe.lineTo(1.24 + nx, tipY + 0.12);
  stripe.quadraticCurveTo(1.0 + nx * 0.6, hoodY - 0.01, 0.6, 0.875);
  stripe.quadraticCurveTo(0.3, 0.925, 0.1, 0.81);
  stripe.closePath();
  add(extrudeAcross(stripe, 0.16, 0), stripeMat, 0, 0.012, 0);
  for (const side of [1, -1]) {
    for (let k = 0; k < 3; k++) add(new THREE.BoxGeometry(0.02, 0.035, 0.2), dark, side * 0.375, 0.66 - k * 0.06, 0.62 - k * 0.04);
    // Side panel flare and running board.
    add(new THREE.BoxGeometry(0.1, 0.22, 0.75), paintDark, side * 0.37, 0.47, 0.2).rotation.y = side * 0.08;
    add(new THREE.BoxGeometry(0.2, 0.035, 1.05), dark, side * 0.45, 0.33, -0.55);
    add(new THREE.BoxGeometry(0.2, 0.05, 0.06), metal, side * 0.45, 0.35, -0.04);
    // Shock tower: where the front coil-over bolts to the chassis.
    add(new THREE.BoxGeometry(0.1, 0.12, 0.14), dark, side * 0.38, 0.68, 0.84);
  }

  // Headlight pod and tail light.
  add(new THREE.BoxGeometry(0.44, 0.13, 0.08), dark, 0, tipY + 0.14, 1.27 + nx).rotation.x = -0.5;
  const lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c4, emissiveIntensity: 2.2 });
  for (const side of [1, -1]) add(new THREE.BoxGeometry(0.15, 0.07, 0.05), lamp, side * 0.11, tipY + 0.14, 1.3 + nx).rotation.x = -0.5;
  add(new THREE.BoxGeometry(0.42, 0.07, 0.04), new THREE.MeshStandardMaterial({ color: 0x8a1016, emissive: 0xff2a2a, emissiveIntensity: 1.6 }), 0, 0.55, -1.39);
  // Front bumper.
  const bumper = add(new THREE.CylinderGeometry(0.022, 0.022, 0.6, 6), metal, 0, 0.42, 1.4 + nx);
  bumper.rotation.z = Math.PI / 2;

  // Windshield: a tinted curved screen.
  const shield = add(
    new THREE.CylinderGeometry(0.33, 0.39, 0.46, 14, 1, true, -1.0, 2.0),
    new THREE.MeshStandardMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.38, roughness: 0.08, side: THREE.DoubleSide }),
    0,
    1.08,
    0.12,
  );
  shield.rotation.x = -0.38;
  shield.scale.y = shape.windshield;
  shield.position.y += 0.23 * (shape.windshield - 1);
  shield.castShadow = false;

  // Handlebars, grips and hand guards.
  limb([0, 0.86, 0.26], [0, 1.05, 0.14], 0.03, metal, body);
  const bars = add(new THREE.CylinderGeometry(0.022, 0.022, 0.76, 8), metal, 0, 1.06, 0.13);
  bars.rotation.z = Math.PI / 2;
  for (const side of [1, -1]) {
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.14, 8), rubber, side * 0.34, 1.06, 0.13).rotation.z = Math.PI / 2;
    add(new THREE.BoxGeometry(0.16, 0.1, 0.03), paint, side * 0.33, 1.07, 0.2);
  }

  // Seat with a raised back, on the tunnel.
  add(new THREE.BoxGeometry(0.5, 0.13, 0.95), dark, 0, 0.7, -0.62);
  add(new THREE.BoxGeometry(0.46, 0.16, 0.28), dark, 0, 0.8, -1.06).rotation.x = -0.25;
  add(new THREE.BoxGeometry(0.52, 0.03, 0.9), paint, 0, 0.635, -0.62);
  // Rear rack and snow flap.
  for (const side of [1, -1]) limb([side * 0.24, 0.62, -1.12], [side * 0.24, 0.7, -1.4], 0.016, metal, body);
  limb([-0.24, 0.7, -1.4], [0.24, 0.7, -1.4], 0.016, metal, body);
  add(new THREE.BoxGeometry(0.56, 0.3, 0.03), rubber, 0, 0.36, -1.44).rotation.x = 0.3;

  if (shape.cargo) {
    add(new THREE.BoxGeometry(0.62, 0.34, 0.5), dark, 0, 0.9, -1.22);
    add(new THREE.BoxGeometry(0.66, 0.05, 0.54), paint, 0, 1.09, -1.22);
  }
  if (shape.fin) add(new THREE.BoxGeometry(0.04, 0.34, 0.5), paint, 0, 0.92, -1.2).rotation.x = -0.35;

  // ---------- Rider ----------

  const jacket = new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
  const pants = new THREE.MeshStandardMaterial({ color: 0x1b242e, roughness: 0.85 });
  rider.position.set(0, 0.77, -0.55);
  body.add(rider);
  add(new THREE.BoxGeometry(0.36, 0.18, 0.3), pants, 0, 0.08, 0, rider);
  limb([0, 0.16, 0], [0, 0.6, 0.24], 0.17, jacket, rider);
  add(new THREE.BoxGeometry(0.3, 0.2, 0.03), trim, 0, 0.42, 0.01, rider).rotation.x = 0.5;
  add(new THREE.SphereGeometry(0.2, 18, 12), new THREE.MeshStandardMaterial({ color: helmet, roughness: 0.25, metalness: 0.3 }), 0, 0.9, 0.34, rider);
  add(new THREE.BoxGeometry(0.28, 0.11, 0.1), new THREE.MeshStandardMaterial({ color: 0x0b0e12, roughness: 0.1, metalness: 0.6 }), 0, 0.91, 0.5, rider);
  add(new THREE.BoxGeometry(0.26, 0.03, 0.14), dark, 0, 1.0, 0.5, rider);
  for (const side of [1, -1]) {
    limb([side * 0.23, 0.6, 0.22], [side * 0.34, 0.42, 0.44], 0.06, jacket, rider);
    limb([side * 0.34, 0.42, 0.44], [side * 0.33, 0.3, 0.66], 0.05, jacket, rider);
    add(new THREE.BoxGeometry(0.1, 0.09, 0.12), dark, side * 0.33, 0.29, 0.69, rider);
    limb([side * 0.14, 0.08, 0.05], [side * 0.33, 0.04, 0.4], 0.085, pants, rider);
    limb([side * 0.33, 0.04, 0.4], [side * 0.43, -0.32, 0.22], 0.07, pants, rider);
    add(new THREE.BoxGeometry(0.13, 0.12, 0.3), dark, side * 0.43, -0.37, 0.28, rider);
  }

  // ---------- Unsprung: drive track ----------

  const loop = new THREE.Shape();
  loop.moveTo(-1.2, 0);
  loop.lineTo(-0.2, 0);
  loop.absarc(-0.2, 0.15, 0.15, -Math.PI / 2, Math.PI / 2, false);
  loop.lineTo(-1.2, 0.3);
  loop.absarc(-1.2, 0.15, 0.15, Math.PI / 2, Math.PI * 1.5, false);
  const drive = new THREE.Group();
  drive.scale.set(shape.width, 1, shape.length);
  group.add(drive);
  add(extrudeAcross(loop, 0.38, 0), rubber, 0, 0, 0, drive);
  // Lugs give the belt some tooth.
  for (let k = 0; k < 9; k++) add(new THREE.BoxGeometry(0.4, 0.035, 0.05), dark, 0, 0.005, -0.25 - k * 0.115, drive);
  for (const side of [1, -1]) {
    for (const z of [-0.3, -0.7, -1.1]) {
      add(new THREE.CylinderGeometry(0.085, 0.085, 0.03, 12), metal, side * 0.205, 0.14, z, drive).rotation.z = Math.PI / 2;
    }
    limb([side * 0.21, 0.14, -0.25], [side * 0.21, 0.14, -1.15], 0.018, metal, drive);
  }

  // ---------- Unsprung: skis ----------

  const skiCarriers: THREE.Group[] = [];
  const skis: THREE.Group[] = [];
  const struts: Strut[] = [];
  const coil = coilGeometry();

  /** A coil-over shock between a body mount and an unsprung mount. */
  const shock = (top: [number, number, number], bottom: [number, number, number], ski: number) => {
    const node = new THREE.Group();
    add(new THREE.CylinderGeometry(0.036, 0.036, 0.2, 8), dark, 0, -0.1, 0, node);
    add(new THREE.CylinderGeometry(0.068, 0.068, 0.02, 10), metal, 0, -0.03, 0, node);
    const rod = add(new THREE.CylinderGeometry(0.014, 0.014, 1, 6), metal, 0, 0, 0, node);
    rod.geometry.translate(0, -0.5, 0);
    const spring = add(coil, springMat, 0, 0, 0, node);
    group.add(node);
    struts.push({ top: new THREE.Vector3(...top), bottom: new THREE.Vector3(...bottom), ski, node, stretch: [rod, spring] });
  };
  /** A suspension arm between a body pivot and an unsprung one. */
  const arm = (top: [number, number, number], bottom: [number, number, number], ski: number) => {
    const node = new THREE.Group();
    const bar = add(new THREE.BoxGeometry(0.035, 1, 0.07), metal, 0, 0, 0, node);
    bar.geometry.translate(0, -0.5, 0);
    group.add(node);
    struts.push({ top: new THREE.Vector3(...top), bottom: new THREE.Vector3(...bottom), ski, node, stretch: [bar] });
  };

  [1, -1].forEach((side, i) => {
    const carrier = new THREE.Group();
    const skiX = shape.stance;
    const skiZ = 0.85 * shape.length;
    carrier.position.set(side * skiX, 0, skiZ);
    const pivot = new THREE.Group();
    carrier.add(pivot);
    pivot.scale.x = shape.ski;
    // Ski: flat runner, upswept tip in two steps, a keel underneath and a grab loop.
    add(new THREE.BoxGeometry(0.16, 0.035, 1.2), paint, 0, 0.03, -0.05, pivot);
    add(new THREE.BoxGeometry(0.16, 0.035, 0.26), paint, 0, 0.065, 0.66, pivot).rotation.x = -0.3;
    add(new THREE.BoxGeometry(0.15, 0.035, 0.2), paint, 0, 0.16, 0.86, pivot).rotation.x = -0.75;
    add(new THREE.BoxGeometry(0.03, 0.03, 0.9), metal, 0, 0.005, -0.05, pivot);
    const grab = add(new THREE.TorusGeometry(0.1, 0.014, 6, 10, Math.PI), dark, 0, 0.1, 0.62, pivot);
    grab.rotation.y = Math.PI / 2;
    // Spindle the suspension bolts to.
    add(new THREE.BoxGeometry(0.07, 0.3, 0.09), metal, -side * 0.06, 0.2, 0, carrier);
    group.add(carrier);
    skiCarriers.push(carrier);
    skis.push(pivot);

    // Tops are in the body's own units (it gets stretched); bottoms are where the ski actually is.
    arm([side * 0.26, 0.31, 0.85], [side * (skiX - 0.06), 0.1, skiZ], i);
    arm([side * 0.26, 0.46, 0.82], [side * (skiX - 0.06), 0.3, skiZ], i);
    shock([side * 0.4, 0.7, 0.84], [side * (skiX - 0.1), 0.14, skiZ + 0.01], i);
    // Rear coil-over, from the tunnel down to the track frame.
    shock([side * 0.29, 0.6, -0.78], [side * 0.26 * shape.width, 0.17, -1.08 * shape.length], -1);
  });

  const model: SledModel = { group, body, rider, skiCarriers, skis, struts };
  poseSledModel(model, 0, 0, 0, 0, 0, 0);
  return model;
}

/**
 * Poses the moving parts for this frame: the body's ride height and attitude,
 * each ski's travel, and every arm and shock stretched between its two mounts.
 */
export function poseSledModel(
  m: SledModel,
  heave: number,
  skiLeft: number,
  skiRight: number,
  steer: number,
  lean: number,
  pitch: number,
) {
  m.body.position.y = heave;
  m.body.rotation.set(pitch, 0, lean * 0.45);
  // The rider throws their weight further into the turn than the sled leans.
  m.rider.rotation.z = lean * 0.9;
  m.skiCarriers[0].position.y = skiLeft;
  m.skiCarriers[1].position.y = skiRight;
  for (const ski of m.skis) ski.rotation.y = steer * 0.35;

  for (const s of m.struts) {
    _a.copy(s.top).multiply(m.body.scale).applyEuler(m.body.rotation);
    _a.y += heave;
    _b.copy(s.bottom);
    if (s.ski >= 0) _b.y += s.ski === 0 ? skiLeft : skiRight;
    const len = _a.distanceTo(_b);
    s.node.position.copy(_a);
    s.node.quaternion.setFromUnitVectors(DOWN, _d.copy(_b).sub(_a).divideScalar(len));
    for (const part of s.stretch) part.scale.y = len;
  }
}
