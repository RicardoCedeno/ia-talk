import * as THREE from 'three';
import { AgentBody } from './agent-body';
import { AFFINITY_DRIFT, FIGHT_THRESHOLD } from './social';
import { Entity, EntityType } from '../world/entities';
import { WORLD_HALF } from '../world/world';

/**
 * Prioridad de una acción en curso. Un suceso solo la interrumpe si su nivel es
 * igual o mayor: ver una manzana corta un paseo; que te hablen corta también una caminata.
 */
export const PRIORITY = { idle: 0, move: 1, task: 2 } as const;

export const AGENT_RADIUS = 0.4;
export const WALK_SPEED = 2.4;
/** Altura (m) a la que flota quien levita. */
export const LEVITATE_HEIGHT = 1.4;
/** Obstáculos bajos que se sobrevuelan levitando (los árboles y los personajes, no). */
const LOW_OBSTACLES = new Set<EntityType>(['rock', 'chest', 'pond']);

export type Power = 'levitar';
const TURN_RATE = 7;
// Lentas a propósito: que les quede tiempo para charlar y explorar entre comida y comida.
const HUNGER_PER_SECOND = 0.3;
const THIRST_PER_SECOND = 0.4;

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Una acción es un generador que avanza un paso por frame: recibe `dt` en cada
 * `yield` y devuelve el resultado al terminar.
 */
export type ActionGen = Generator<undefined, ActionResult, number>;

export interface KnownEntity {
  id: string;
  type: EntityType;
  position: THREE.Vector3;
  lastSeen: number;
}

interface RunningAction {
  label: string;
  gen: ActionGen;
  priority: number;
  resolve: (result: ActionResult) => void;
}

const CELL_SIZE = 4;

/** Clave de la celda de CELL_SIZE×CELL_SIZE m que contiene el punto. */
export function cellKey(x: number, z: number): string {
  return `${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`;
}

/** Diferencia angular normalizada a [-π, π]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Estado y capacidades físicas del personaje. Las decisiones vienen de fuera. */
export class Agent {
  readonly body: AgentBody;
  hunger = 0;
  thirst = 0;
  holding: Entity | null = null;
  /** Lo que el agente ha visto alguna vez y dónde. */
  readonly known = new Map<string, KnownEntity>();
  /** Celdas del mapa que ya ha tenido a la vista (para explorar zonas nuevas). */
  readonly explored = new Set<string>();
  /** Afinidad (-100..100) hacia cada otro personaje, por id. */
  readonly affinity = new Map<string, number>();
  /** Últimas frases que ha dicho, para no repetirse. */
  readonly recentLines: string[] = [];
  /** Superpoderes adquiridos (p. ej. al tocar la esfera). */
  readonly powers = new Set<Power>();
  levitating = false;
  /** Si ya ha probado a levitar alguna vez (para animarle a estrenar el poder). */
  hasLevitated = false;

  private current: RunningAction | null = null;
  /** Hacia dónde mira cuando está sin hacer nada (p. ej. a quien le habla). */
  private attention: { target: THREE.Vector3; seconds: number } | null = null;
  private readonly dir = new THREE.Vector3();
  private readonly avoid = new THREE.Vector3();

  constructor(
    readonly id: string,
    readonly name: string,
    color: string,
  ) {
    this.body = new AgentBody(color, name);
  }

  /** Está peleado con alguien. */
  get angry(): boolean {
    for (const v of this.affinity.values()) if (v <= FIGHT_THRESHOLD) return true;
    return false;
  }

  getAffinity(otherId: string): number {
    return this.affinity.get(otherId) ?? 0;
  }

  changeAffinity(otherId: string, delta: number): void {
    this.affinity.set(otherId, THREE.MathUtils.clamp(this.getAffinity(otherId) + delta, -100, 100));
  }

  /** Mira hacia un punto (que puede moverse) durante unos segundos si no está ocupado. */
  lookAt(target: THREE.Vector3, seconds: number): void {
    this.attention = { target, seconds };
  }

  get position(): THREE.Vector3 {
    return this.body.root.position;
  }

  get heading(): number {
    return this.body.root.rotation.y;
  }

  set heading(value: number) {
    this.body.root.rotation.y = angleDiff(value, 0);
  }

  get actionLabel(): string | null {
    return this.current?.label ?? null;
  }

  forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  reset(x = 0, z = 0, heading = 0): void {
    this.cancel('Reinicio del mundo.');
    this.holding?.object.removeFromParent();
    this.holding = null;
    this.position.set(x, 0, z);
    this.heading = heading;
    this.hunger = 25 + Math.random() * 15;
    this.thirst = 20 + Math.random() * 15;
    this.known.clear();
    this.explored.clear();
    this.affinity.clear();
    this.recentLines.length = 0;
    this.powers.clear();
    this.levitating = false;
    this.hasLevitated = false;
    this.attention = null;
    this.body.setAnim('idle');
    this.body.hideBubble();
  }

  /** Ejecuta una acción; cancela la anterior si la hubiera. */
  run(label: string, gen: ActionGen, priority: number = PRIORITY.task): Promise<ActionResult> {
    this.cancel('Interrumpida por otra acción.');
    return new Promise((resolve) => {
      this.current = { label, gen, priority, resolve };
      this.step(0);
    });
  }

  cancel(reason: string): void {
    const running = this.current;
    if (!running) return;
    this.current = null;
    const result = { ok: false, message: reason };
    running.gen.return(result);
    running.resolve(result);
    this.body.setAnim('idle');
  }

  /** Cancela la acción actual si su prioridad no supera `upTo` (ver PRIORITY). */
  interrupt(reason: string, upTo: number): boolean {
    if (!this.current || this.current.priority > upTo) return false;
    this.cancel(reason);
    return true;
  }

  update(dt: number): void {
    this.hunger = Math.min(100, this.hunger + HUNGER_PER_SECOND * dt);
    this.thirst = Math.min(100, this.thirst + THIRST_PER_SECOND * dt);
    for (const [id, v] of this.affinity) {
      this.affinity.set(id, v > 0 ? Math.max(0, v - AFFINITY_DRIFT * dt) : Math.min(0, v + AFFINITY_DRIFT * dt));
    }

    if (this.current) {
      this.step(dt);
    } else if (this.attention) {
      this.faceTowards(this.attention.target, dt);
      this.attention.seconds -= dt;
      if (this.attention.seconds <= 0) this.attention = null;
    }
    this.body.carrying = this.holding !== null;
    this.body.angry = this.angry;
    this.body.hoverTarget = this.levitating ? LEVITATE_HEIGHT : 0;
    this.body.update(dt);
  }

  /** Si un sólido le bloquea levitando, los bajos no cuentan. */
  private blocks(s: Entity): boolean {
    return s.id !== this.id && !(this.levitating && LOW_OBSTACLES.has(s.type));
  }

  /** Saca al agente de cualquier sólido en el que esté metido y lo mantiene dentro del mundo. */
  resolveCollisions(solids: Entity[]): void {
    const pos = this.position;
    for (const s of solids) {
      if (!this.blocks(s)) continue;
      const ox = pos.x - s.object.position.x;
      const oz = pos.z - s.object.position.z;
      const d = Math.hypot(ox, oz);
      const minD = s.radius + AGENT_RADIUS;
      if (d < minD && d > 1e-4) {
        pos.x = s.object.position.x + (ox / d) * minD;
        pos.z = s.object.position.z + (oz / d) * minD;
      }
    }
    const limit = WORLD_HALF - 0.5;
    pos.x = THREE.MathUtils.clamp(pos.x, -limit, limit);
    pos.z = THREE.MathUtils.clamp(pos.z, -limit, limit);
  }

  distanceTo(p: THREE.Vector3): number {
    return Math.hypot(p.x - this.position.x, p.z - this.position.z);
  }

  /** Gira hacia un punto. Devuelve true cuando ya está orientado. */
  faceTowards(p: THREE.Vector3, dt: number): boolean {
    const desired = Math.atan2(p.x - this.position.x, p.z - this.position.z);
    const diff = angleDiff(desired, this.heading);
    this.heading = this.heading + diff * Math.min(1, TURN_RATE * dt);
    return Math.abs(diff) < 0.15;
  }

  /** Avanza hacia `target` esquivando obstáculos sólidos (steering simple). */
  steer(target: THREE.Vector3, dt: number, solids: Entity[], ignoreId?: string): void {
    const pos = this.position;
    const dir = this.dir.set(target.x - pos.x, 0, target.z - pos.z);
    const dist = dir.length();
    if (dist < 1e-4) return;
    dir.divideScalar(dist);

    const avoid = this.avoid.set(0, 0, 0);
    for (const s of solids) {
      if (s.id === ignoreId || !this.blocks(s)) continue;
      const ox = pos.x - s.object.position.x;
      const oz = pos.z - s.object.position.z;
      const d = Math.hypot(ox, oz);
      const minD = s.radius + AGENT_RADIUS;
      const range = minD + 1.2;
      if (d > range || d < 1e-4) continue;
      const nx = ox / d;
      const nz = oz / d;
      const ahead = -(nx * dir.x + nz * dir.z); // > 0 si el obstáculo está delante
      if (ahead <= 0) continue;
      const strength = ((range - d) / (range - minD)) * ahead;
      // Empuja hacia un lado (tangente) para rodear en vez de frenar en seco.
      const tx = -nz;
      const tz = nx;
      const side = Math.sign(tx * dir.x + tz * dir.z) || 1;
      avoid.x += (nx * 0.5 + tx * side) * strength;
      avoid.z += (nz * 0.5 + tz * side) * strength;
    }
    dir.addScaledVector(avoid, 1.5).normalize();

    const diff = angleDiff(Math.atan2(dir.x, dir.z), this.heading);
    this.heading = this.heading + diff * Math.min(1, TURN_RATE * dt);
    const speedFactor = THREE.MathUtils.clamp((Math.cos(diff) + 0.3) / 1.3, 0, 1);
    const stepLen = Math.min(WALK_SPEED * speedFactor * dt, dist);
    pos.x += Math.sin(this.heading) * stepLen;
    pos.z += Math.cos(this.heading) * stepLen;
    this.body.stride = speedFactor;

    // Colisión dura: nunca atravesar un sólido.
    this.resolveCollisions(solids);
  }

  private step(dt: number): void {
    const running = this.current;
    if (!running) return;
    let next: IteratorResult<undefined, ActionResult>;
    try {
      next = running.gen.next(dt);
    } catch (e) {
      next = { done: true, value: { ok: false, message: `Error interno: ${String(e)}` } };
    }
    if (next.done && this.current === running) {
      this.current = null;
      running.resolve(next.value);
    }
  }
}
