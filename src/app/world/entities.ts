import * as THREE from 'three';

export type EntityType = 'tree' | 'rock' | 'apple' | 'chest' | 'pond' | 'character' | 'marvel';

export const TYPE_NAMES: Record<EntityType, string> = {
  tree: 'árbol',
  rock: 'roca',
  apple: 'manzana',
  chest: 'cofre',
  pond: 'estanque',
  character: 'personaje',
  marvel: 'objeto imposible',
};

export interface Entity {
  readonly id: string;
  readonly type: EntityType;
  readonly object: THREE.Object3D;
  /** Radio en el plano XZ, usado para colisiones e interacción. */
  readonly radius: number;
  /** Si bloquea el paso del personaje. */
  readonly solid: boolean;
  /** Mallas que tapan la visión del personaje. */
  readonly occluders: readonly THREE.Object3D[];
}

// Geometrías y materiales compartidos por todas las instancias.
const geo = {
  trunk: new THREE.CylinderGeometry(0.18, 0.26, 2.2, 8),
  leavesLow: new THREE.ConeGeometry(1.3, 2, 8),
  leavesHigh: new THREE.ConeGeometry(0.9, 1.5, 8),
  rock: new THREE.DodecahedronGeometry(1, 0),
  apple: new THREE.SphereGeometry(0.16, 14, 10),
  stem: new THREE.CylinderGeometry(0.015, 0.015, 0.1, 5),
  chestBase: new THREE.BoxGeometry(0.9, 0.5, 0.6),
  chestLid: new THREE.BoxGeometry(0.94, 0.16, 0.64),
  chestLock: new THREE.BoxGeometry(0.12, 0.14, 0.04),
  water: new THREE.CircleGeometry(1, 48),
  pebble: new THREE.DodecahedronGeometry(0.28, 0),
};

const mat = {
  trunk: new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.9 }),
  leaves: new THREE.MeshStandardMaterial({ color: 0x3f8f3a, roughness: 0.8, flatShading: true }),
  leavesLight: new THREE.MeshStandardMaterial({ color: 0x56a845, roughness: 0.8, flatShading: true }),
  rock: new THREE.MeshStandardMaterial({ color: 0x8d8f94, roughness: 0.9, flatShading: true }),
  apple: new THREE.MeshStandardMaterial({ color: 0xd8262b, roughness: 0.45 }),
  stem: new THREE.MeshStandardMaterial({ color: 0x5a3b1c }),
  wood: new THREE.MeshStandardMaterial({ color: 0x9b6a3c, roughness: 0.8 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x6e4826, roughness: 0.8 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xe8c547, metalness: 0.6, roughness: 0.3 }),
  water: new THREE.MeshStandardMaterial({
    color: 0x3a8fd6,
    roughness: 0.15,
    metalness: 0.1,
    transparent: true,
    opacity: 0.85,
  }),
  pebble: new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.9, flatShading: true }),
};

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, y = 0): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.position.y = y;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function createTree(id: string): Entity {
  const group = new THREE.Group();
  const trunk = mesh(geo.trunk, mat.trunk, 1.1);
  group.add(trunk, mesh(geo.leavesLow, mat.leaves, 3.1), mesh(geo.leavesHigh, mat.leavesLight, 4));
  group.rotation.y = Math.random() * Math.PI * 2;
  return { id, type: 'tree', object: group, radius: 0.35, solid: true, occluders: [trunk] };
}

export function createRock(id: string): Entity {
  const size = 0.45 + Math.random() * 0.45;
  const rock = mesh(geo.rock, mat.rock);
  rock.scale.set(size, size * 0.7, size);
  rock.rotation.set(Math.random(), Math.random() * Math.PI * 2, Math.random());
  const group = new THREE.Group();
  group.add(rock);
  return { id, type: 'rock', object: group, radius: size * 0.85, solid: true, occluders: [rock] };
}

export function createApple(id: string): Entity {
  const group = new THREE.Group();
  const stem = mesh(geo.stem, mat.stem, 0.17);
  stem.rotation.z = 0.3;
  group.add(mesh(geo.apple, mat.apple), stem);
  return { id, type: 'apple', object: group, radius: 0.16, solid: false, occluders: [] };
}

export function createChest(id: string): Entity {
  const group = new THREE.Group();
  const base = mesh(geo.chestBase, mat.wood, 0.25);
  const lock = mesh(geo.chestLock, mat.gold, 0.45);
  lock.position.z = 0.32;
  group.add(base, mesh(geo.chestLid, mat.woodDark, 0.57), lock);
  return { id, type: 'chest', object: group, radius: 0.55, solid: true, occluders: [base] };
}

export function createPond(id: string, radius = 3): Entity {
  const group = new THREE.Group();
  const water = new THREE.Mesh(geo.water, mat.water);
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.03;
  water.scale.set(radius, radius, 1);
  water.receiveShadow = true;
  group.add(water);

  const pebbles = Math.round(radius * 6);
  for (let i = 0; i < pebbles; i++) {
    const a = (i / pebbles) * Math.PI * 2;
    const p = mesh(geo.pebble, mat.pebble);
    p.position.set(Math.cos(a) * (radius + 0.15), 0.05, Math.sin(a) * (radius + 0.15));
    p.scale.setScalar(0.7 + Math.random() * 0.5);
    p.rotation.set(Math.random(), Math.random(), Math.random());
    group.add(p);
  }
  return { id, type: 'pond', object: group, radius, solid: true, occluders: [] };
}
