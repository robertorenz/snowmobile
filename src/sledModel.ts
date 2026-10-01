import * as THREE from 'three';

export interface SledModel {
  group: THREE.Group;
  /** Inner group that leans into turns. */
  body: THREE.Group;
  skis: THREE.Group[];
}

/** Builds a snowmobile and rider from primitives. Faces +Z, origin on the snow. */
export function buildSledModel(color: number, helmet: number): SledModel {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.25 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.85 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xaab4bd, roughness: 0.35, metalness: 0.8 });
  const suit = new THREE.MeshStandardMaterial({ color: 0x1c2733, roughness: 0.8 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = body) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // Hull: side profile extruded across the sled's width.
  const profile = new THREE.Shape();
  profile.moveTo(-1.35, 0.3);
  profile.lineTo(-1.4, 0.58);
  profile.lineTo(-1.15, 0.66);
  profile.lineTo(-0.15, 0.66);
  profile.lineTo(0.1, 0.84);
  profile.lineTo(0.55, 0.88);
  profile.lineTo(1.2, 0.58);
  profile.lineTo(1.32, 0.42);
  profile.lineTo(1.0, 0.28);
  profile.closePath();
  const hull = new THREE.ExtrudeGeometry(profile, {
    depth: 0.66,
    bevelEnabled: true,
    bevelSize: 0.05,
    bevelThickness: 0.05,
    bevelSegments: 2,
  });
  hull.rotateY(-Math.PI / 2);
  hull.translate(0.33, 0, 0);
  add(hull, paint, 0, 0, 0);

  add(new THREE.BoxGeometry(0.5, 0.12, 1.0), dark, 0, 0.72, -0.65); // seat
  add(new THREE.BoxGeometry(0.44, 0.26, 1.75), dark, 0, 0.16, -0.55); // drive track
  add(new THREE.BoxGeometry(0.5, 0.3, 0.04), dark, 0, 0.32, -1.46).rotation.x = 0.3; // snow flap
  add(new THREE.BoxGeometry(0.34, 0.08, 0.05), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c4, emissiveIntensity: 2 }), 0, 0.6, 1.22);
  add(new THREE.BoxGeometry(0.4, 0.07, 0.04), new THREE.MeshStandardMaterial({ color: 0x8a1016, emissive: 0xff2a2a, emissiveIntensity: 1.5 }), 0, 0.56, -1.44);

  const shield = add(
    new THREE.BoxGeometry(0.62, 0.42, 0.03),
    new THREE.MeshStandardMaterial({ color: 0xa8dcff, transparent: true, opacity: 0.4, roughness: 0.1 }),
    0,
    1.04,
    0.42,
  );
  shield.rotation.x = -0.5;
  shield.castShadow = false;

  const bars = add(new THREE.CylinderGeometry(0.025, 0.025, 0.72, 6), metal, 0, 1.0, 0.14);
  bars.rotation.z = Math.PI / 2;
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 6), metal, 0, 0.9, 0.2).rotation.x = -0.4;

  // Skis on steerable pivots.
  const skis: THREE.Group[] = [];
  for (const side of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.52, 0, 0.82);
    add(new THREE.BoxGeometry(0.15, 0.05, 1.25), paint, 0, 0.03, 0, pivot);
    add(new THREE.BoxGeometry(0.15, 0.05, 0.32), paint, 0, 0.1, 0.74, pivot).rotation.x = -0.5;
    const strut = add(new THREE.BoxGeometry(0.06, 0.42, 0.06), metal, -side * 0.12, 0.24, 0, pivot);
    strut.rotation.z = -side * 0.5;
    body.add(pivot);
    skis.push(pivot);
  }

  // Rider
  const jacket = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  add(new THREE.BoxGeometry(0.44, 0.58, 0.28), jacket, 0, 1.12, -0.45).rotation.x = 0.35;
  add(new THREE.SphereGeometry(0.18, 14, 10), new THREE.MeshStandardMaterial({ color: helmet, roughness: 0.3, metalness: 0.2 }), 0, 1.54, -0.27);
  add(new THREE.BoxGeometry(0.24, 0.1, 0.06), dark, 0, 1.55, -0.11); // visor
  for (const side of [1, -1]) {
    add(new THREE.BoxGeometry(0.1, 0.1, 0.56), jacket, side * 0.28, 1.16, -0.1).rotation.x = 0.55;
    add(new THREE.BoxGeometry(0.15, 0.4, 0.5), suit, side * 0.3, 0.74, -0.42).rotation.x = -0.25;
  }

  return { group, body, skis };
}
