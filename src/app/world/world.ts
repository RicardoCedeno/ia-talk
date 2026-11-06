import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  createApple,
  createChest,
  createPond,
  createRock,
  createTree,
  Entity,
  EntityType,
} from './entities';

/** Medio lado del mundo jugable (el mundo va de -WORLD_HALF a +WORLD_HALF). */
export const WORLD_HALF = 20;

const MAX_APPLES = 6;
const APPLE_SPAWN_SECONDS = 10;
const LABEL_HEIGHT: Record<EntityType, number> = {
  tree: 4.9,
  rock: 1.1,
  apple: 0.55,
  chest: 1.05,
  pond: 0.5,
  character: 2.6,
  marvel: 3,
};

/** Registro de entidades del mundo y su generación. */
export class World {
  readonly root = new THREE.Group();

  private readonly entities = new Map<string, Entity>();
  /** Los personajes no se borran al regenerar el mundo; su objeto vive en la escena. */
  private readonly characters = new Map<string, Entity>();
  private readonly labels = new Map<string, CSS2DObject>();
  private readonly counters = new Map<EntityType, number>();
  private readonly chestLabelEl = document.createElement('div');
  private readonly chestLabel = new CSS2DObject(this.chestLabelEl);
  private labelsVisible = false;
  private spawnTimer = 0;
  private storedApples = 0;

  constructor() {
    this.chestLabelEl.className = 'chest-label';
    this.chestLabel.position.y = 1.05;
    this.chestLabel.center.set(0.5, 1);
    this.chestLabel.visible = false;
  }

  get chestApples(): number {
    return this.storedApples;
  }

  set chestApples(n: number) {
    this.storedApples = n;
    this.chestLabelEl.textContent = `🍎 × ${n}`;
    this.chestLabel.visible = n > 0;
  }

  get(id: string): Entity | undefined {
    return this.entities.get(id) ?? this.characters.get(id);
  }

  all(): Entity[] {
    return [...this.entities.values(), ...this.characters.values()];
  }

  addCharacter(entity: Entity): void {
    entity.object.userData['entityId'] = entity.id;
    this.characters.set(entity.id, entity);
  }

  removeCharacter(id: string): void {
    this.characters.delete(id);
  }

  byType(type: EntityType): Entity[] {
    return this.all().filter((e) => e.type === type);
  }

  solids(): Entity[] {
    return this.all().filter((e) => e.solid);
  }

  occluders(): THREE.Object3D[] {
    return this.all().flatMap((e) => e.occluders);
  }

  nextId(type: EntityType): string {
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    return `${type}-${n}`;
  }

  add(entity: Entity): void {
    entity.object.userData['entityId'] = entity.id;
    this.entities.set(entity.id, entity);
    this.root.add(entity.object);

    const el = document.createElement('div');
    el.className = 'entity-label';
    el.textContent = entity.id;
    const label = new CSS2DObject(el);
    label.position.y = LABEL_HEIGHT[entity.type];
    label.visible = this.labelsVisible;
    entity.object.add(label);
    this.labels.set(entity.id, label);
  }

  /** Quita la entidad del mundo (sin destruirla: puede pasar a las manos del agente). */
  remove(id: string): Entity | undefined {
    const entity = this.entities.get(id);
    if (!entity) return undefined;
    // removeFromParent dispara el evento que borra el elemento DOM de la etiqueta.
    this.labels.get(id)?.removeFromParent();
    this.labels.delete(id);
    entity.object.removeFromParent();
    this.entities.delete(id);
    return entity;
  }

  setLabelsVisible(visible: boolean): void {
    this.labelsVisible = visible;
    for (const label of this.labels.values()) label.visible = visible;
  }

  /** Resalta en modo depuración las entidades que el agente ve ahora mismo. */
  markVisible(ids: ReadonlySet<string>): void {
    for (const [id, label] of this.labels) label.element.classList.toggle('seen', ids.has(id));
  }

  clear(): void {
    this.chestLabel.removeFromParent();
    for (const id of [...this.entities.keys()]) this.remove(id);
    this.counters.clear();
    this.chestApples = 0;
  }

  generate(): void {
    this.clear();

    const pond = createPond(this.nextId('pond'), 3);
    this.place(pond, 2, 9);
    const chest = createChest(this.nextId('chest'));
    this.place(chest, 1.5, 3, 8);
    chest.object.add(this.chestLabel);

    for (let i = 0; i < 11; i++) this.place(createTree(this.nextId('tree')), 1.6);
    for (let i = 0; i < 7; i++) this.place(createRock(this.nextId('rock')), 1);
    for (let i = 0; i < 4; i++) this.spawnApple();
    this.spawnTimer = 0;
  }

  update(dt: number): void {
    this.spawnTimer += dt;
    if (this.spawnTimer >= APPLE_SPAWN_SECONDS) {
      this.spawnTimer = 0;
      if (this.byType('apple').length < MAX_APPLES) this.spawnApple();
    }
  }

  /** Hace aparecer una manzana en el suelo junto a un árbol al azar. */
  spawnApple(): boolean {
    const trees = this.byType('tree');
    if (!trees.length) return false;
    const limit = WORLD_HALF - 1;
    for (let i = 0; i < 20; i++) {
      const tree = trees[Math.floor(Math.random() * trees.length)];
      const angle = Math.random() * Math.PI * 2;
      const dist = 0.9 + Math.random() * 0.8;
      const x = tree.object.position.x + Math.cos(angle) * dist;
      const z = tree.object.position.z + Math.sin(angle) * dist;
      if (Math.abs(x) > limit || Math.abs(z) > limit || this.blocked(x, z, 0.25)) continue;
      const apple = createApple(this.nextId('apple'));
      apple.object.position.set(x, 0.16, z);
      this.add(apple);
      return true;
    }
    return false;
  }

  /** Si cabe algo de radio `radius` en (x, z) sin chocar con sólidos ni salirse del mundo. */
  isFree(x: number, z: number, radius: number): boolean {
    const limit = WORLD_HALF - 1 - radius;
    return Math.abs(x) <= limit && Math.abs(z) <= limit && !this.blocked(x, z, radius, 0.2);
  }

  private blocked(x: number, z: number, radius: number, clearance = 0.1): boolean {
    return this.solids().some(
      (s) =>
        Math.hypot(s.object.position.x - x, s.object.position.z - z) <
        s.radius + radius + clearance,
    );
  }

  /** Un sitio libre al azar para algo de radio `radius`, o null si no lo encuentra. */
  freeSpot(radius: number, clearance: number, minFromOrigin = 3, maxFromOrigin = Infinity): THREE.Vector3 | null {
    const limit = WORLD_HALF - 2 - radius;
    for (let i = 0; i < 300; i++) {
      const x = (Math.random() * 2 - 1) * limit;
      const z = (Math.random() * 2 - 1) * limit;
      const fromOrigin = Math.hypot(x, z);
      if (fromOrigin < minFromOrigin + radius || fromOrigin > maxFromOrigin) continue;
      if (this.blocked(x, z, radius, clearance)) continue;
      return new THREE.Vector3(x, 0, z);
    }
    return null;
  }

  /** Coloca una entidad sólida en un sitio libre al azar. */
  private place(entity: Entity, clearance: number, minFromOrigin = 3, maxFromOrigin = Infinity): void {
    const spot = this.freeSpot(entity.radius, clearance, minFromOrigin, maxFromOrigin);
    if (!spot) return;
    entity.object.position.copy(spot);
    this.add(entity);
  }
}
