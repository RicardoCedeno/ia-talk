import * as THREE from 'three';
import { Agent, angleDiff, cellKey } from './agent';
import { Entity } from '../world/entities';
import { World } from '../world/world';

export const VIEW_DISTANCE = 14;
export const VIEW_FOV = THREE.MathUtils.degToRad(120);
/** Distancia a la que nota cosas aunque estén fuera del cono de visión. */
const NEAR_SENSE = 2;
const EYE_HEIGHT = 1.9;

export type Direction = 'delante' | 'a tu izquierda' | 'a tu derecha';

export interface Perceived {
  entity: Entity;
  /** Distancia en metros (al borde, en el caso del estanque). */
  distance: number;
  direction: Direction;
}

const raycaster = new THREE.Raycaster();
const eye = new THREE.Vector3();
const toTarget = new THREE.Vector3();

/** Ángulo de un punto respecto a hacia dónde mira el agente (positivo = izquierda). */
function relativeAngle(agent: Agent, p: THREE.Vector3): number {
  return angleDiff(Math.atan2(p.x - agent.position.x, p.z - agent.position.z), agent.heading);
}

/** Lo que el agente ve ahora: cono de visión + raycast contra troncos y rocas. */
export function perceive(agent: Agent, world: World): Perceived[] {
  const result: Perceived[] = [];
  const occluders = world.occluders();
  eye.set(agent.position.x, EYE_HEIGHT, agent.position.z);

  for (const entity of world.all()) {
    if (entity.id === agent.id) continue;
    const p = entity.object.position;
    const centerDist = agent.distanceTo(p);
    const isPond = entity.type === 'pond';
    const distance = Math.max(0, isPond ? centerDist - entity.radius : centerDist);
    if (distance > VIEW_DISTANCE) continue;

    const angle = relativeAngle(agent, p);
    // El estanque es grande: basta con que una parte entre en el cono.
    const halfWidth = isPond ? Math.atan2(entity.radius, Math.max(centerDist, 0.01)) : 0;
    const inCone = Math.abs(angle) <= VIEW_FOV / 2 + halfWidth;
    if (!inCone && distance > NEAR_SENSE) continue;

    if (!isPond && centerDist > 1.5) {
      const targetY = entity.type === 'tree' || entity.type === 'marvel' ? 1.5 : entity.type === 'character' ? 1.3 : 0.2;
      toTarget.set(p.x, targetY, p.z).sub(eye);
      const len = toTarget.length();
      raycaster.set(eye, toTarget.divideScalar(len));
      raycaster.far = len - 0.2;
      const blocked = raycaster
        .intersectObjects(occluders, false)
        .some((hit) => !entity.occluders.includes(hit.object));
      if (blocked) continue;
    }

    const deg = THREE.MathUtils.radToDeg(angle);
    const direction: Direction =
      Math.abs(deg) < 20 ? 'delante' : deg > 0 ? 'a tu izquierda' : 'a tu derecha';
    result.push({ entity, distance: Math.round(distance * 10) / 10, direction });
  }
  return result.sort((a, b) => a.distance - b.distance);
}

/** Marca como exploradas las celdas que caen dentro del cono de visión. */
export function markExplored(agent: Agent): void {
  for (const dist of [0, 3, 7, 11]) {
    for (const deg of [-45, -15, 15, 45]) {
      const a = agent.heading + THREE.MathUtils.degToRad(deg);
      agent.explored.add(
        cellKey(agent.position.x + Math.sin(a) * dist, agent.position.z + Math.cos(a) * dist),
      );
    }
  }
}

/** Dirección de un punto respecto al agente, incluido "detrás", para sonidos. */
export function soundDirection(agent: Agent, p: THREE.Vector3): string {
  const deg = THREE.MathUtils.radToDeg(relativeAngle(agent, p));
  if (Math.abs(deg) < 30) return 'delante de ti';
  if (Math.abs(deg) > 135) return 'detrás de ti';
  return deg > 0 ? 'a tu izquierda' : 'a tu derecha';
}

/** Si un punto debería estar a la vista (para notar que algo ya no está). */
export function canSeePoint(agent: Agent, p: THREE.Vector3, maxDistance: number): boolean {
  return agent.distanceTo(p) < maxDistance && Math.abs(relativeAngle(agent, p)) < VIEW_FOV / 2;
}
