import * as THREE from 'three';
import { ActionGen, ActionResult, Agent, AGENT_RADIUS, cellKey, PRIORITY, WALK_SPEED } from './agent';
import { ANIM_DURATION } from './agent-body';
import {
  GIVE_DISTANCE,
  isRepeated,
  SHOUT_DISTANCE,
  SocialHub,
  TALK_DISTANCE,
  toTone,
  Tone,
  TONES,
} from './social';
import { ChatTool } from '../core/openai.service';
import { createApple, Entity, EntityType, TYPE_NAMES } from '../world/entities';
import type { MarvelApi } from '../world/marvels';
import { World, WORLD_HALF } from '../world/world';

export interface ActionContext {
  readonly agent: Agent;
  readonly world: World;
  readonly social: SocialHub;
  readonly marvels: MarvelApi;
}

export interface StartedAction {
  gen: ActionGen;
  /** Qué sucesos pueden cortarla (ver PRIORITY). */
  priority: number;
}

/** Por debajo de este hambre el agente se niega a comer. */
export const MIN_HUNGER_TO_EAT = 20;

const ok = (message: string): ActionResult => ({ ok: true, message });
const fail = (message: string): ActionResult => ({ ok: false, message });

/** A qué distancia (del centro) se detiene al caminar hacia una entidad. */
export function stopDistance(e: Entity): number {
  return e.solid ? e.radius + AGENT_RADIUS + 0.35 : 0.7;
}

/** Distancia máxima (del centro) para poder interactuar con una entidad. */
export function reach(e: Entity): number {
  return e.solid ? e.radius + AGENT_RADIUS + 0.9 : 1.4;
}

function distanceError(agent: Agent, e: Entity): string | null {
  const d = agent.distanceTo(e.object.position);
  if (d <= reach(e)) return null;
  const shown = Math.max(0, d - (e.solid ? e.radius : 0));
  return `Estás a ${shown.toFixed(1)} m de ${e.id}; acércate primero con walk_to("${e.id}").`;
}

/** Para coger cosas, beber o usar el cofre hay que estar con los pies en el suelo. */
function airborne(agent: Agent): string | null {
  return agent.levitating ? 'Estás flotando en el aire y no llegas; baja primero con land.' : null;
}

function knownOfType(ctx: ActionContext, type: EntityType): Entity | undefined {
  return ctx.world.byType(type).find((e) => ctx.agent.known.has(e.id));
}

function* wait(seconds: number): Generator<undefined, void, number> {
  let t = 0;
  while (t < seconds) t += yield;
}

function* turnTowards(agent: Agent, target: THREE.Vector3): Generator<undefined, void, number> {
  let t = 0;
  while (t < 1.2) {
    const dt = yield;
    t += dt;
    if (agent.faceTowards(target, dt)) return;
  }
}

export function* walkToPoint(
  ctx: ActionContext,
  target: () => THREE.Vector3,
  stop: number,
  ignoreId?: string,
): ActionGen {
  const { agent, world } = ctx;
  const start = agent.distanceTo(target());
  const timeout = (start / WALK_SPEED) * 2.5 + 4;
  let best = start;
  let sinceProgress = 0;
  let elapsed = 0;
  agent.body.setAnim('walk');
  try {
    while (true) {
      const dt = yield;
      const goal = target();
      const d = agent.distanceTo(goal);
      if (d <= stop) return ok('Llegaste.');
      agent.steer(goal, dt, world.solids(), ignoreId);
      elapsed += dt;
      if (d < best - 0.15) {
        best = d;
        sinceProgress = 0;
      } else {
        sinceProgress += dt;
      }
      if (sinceProgress > 2.5 || elapsed > timeout) {
        return fail(`Algo te bloquea el paso; te quedaste a ${d.toFixed(1)} m.`);
      }
    }
  } finally {
    agent.body.setAnim('idle');
  }
}

function* walkTo(ctx: ActionContext, id: string): ActionGen {
  const { agent, world } = ctx;
  if (agent.holding?.id === id) return fail(`Ya llevas ${id} en las manos.`);
  const memory = agent.known.get(id);
  if (!memory) return fail(`No conoces ningún objeto llamado "${id}". Usa solo ids que hayas visto.`);

  const live = world.get(id);
  const where = () => world.get(id)?.object.position ?? memory.position;
  const result = yield* walkToPoint(ctx, where, live ? stopDistance(live) : 0.8, id);
  if (!result.ok) return result;
  if (!world.get(id)) {
    agent.known.delete(id);
    return fail(`Llegaste a donde recordabas ${id}, pero ya no está.`);
  }
  const other = ctx.social.agent(id);
  return ok(`Llegaste junto a ${other ? other.name : id}.`);
}

/** Valida que `id` sea otro personaje que el agente conoce. */
function otherCharacter(ctx: ActionContext, id: string): Agent | string {
  const other = ctx.social.agent(id);
  if (!other || other === ctx.agent) return `No hay ningún personaje con id "${id}".`;
  if (!ctx.agent.known.has(id)) return `No sabes dónde está ${other.name}.`;
  return other;
}

/** Lo que dura el gesto de hablar; después el personaje sigue con lo suyo. */
const talkSeconds = (line: string) => Math.min(6, 1.5 + line.length / 30);
/** Lo que se queda el globo en pantalla: lo que se tarda en leerlo con calma (~14 letras/s). */
const readingSeconds = (line: string) => Math.min(15, Math.max(3, 2 + line.length / 14));

/** Comprueba que la frase no se repite y la apunta. Devuelve un error si ya la dijo. */
function checkNewLine(agent: Agent, line: string): string | null {
  const repeated = isRepeated(line, agent.recentLines);
  if (repeated) return `Ya dijiste algo casi igual hace poco ("${repeated}"). Di algo nuevo o haz otra cosa.`;
  agent.recentLines.push(line);
  if (agent.recentLines.length > 8) agent.recentLines.shift();
  return null;
}

/** Hablar (cerca) o gritar (lejos) a otro personaje. */
function* speakTo(ctx: ActionContext, id: string, text: string, tone: Tone, shout: boolean): ActionGen {
  const { agent, social } = ctx;
  const other = social.agent(id);
  if (!other || other === agent) return fail(`No hay ningún personaje con id "${id}".`);
  const d = agent.distanceTo(other.position);
  if (shout) {
    // Para gritar no hace falta verle: basta con que esté al alcance de la voz.
    if (d > SHOUT_DISTANCE) return fail(`${other.name} está demasiado lejos y no te oye ni gritando.`);
  } else {
    if (!agent.known.has(id)) return fail(`No sabes dónde está ${other.name}; prueba a gritarle con shout_to.`);
    if (d > TALK_DISTANCE) {
      return fail(
        `${other.name} está a ${d.toFixed(1)} m y no te oiría hablando normal; ` +
          `grítale con shout_to("${id}") o acércate con walk_to("${id}").`,
      );
    }
  }
  const line = text.trim().slice(0, 220);
  if (!line) return fail('No dijiste nada.');
  const repeated = checkNewLine(agent, line);
  if (repeated) return fail(repeated);

  if (agent.known.has(id)) yield* turnTowards(agent, other.position);
  const seconds = talkSeconds(line);
  agent.body.speak(line, readingSeconds(line), tone, shout);
  agent.body.setAnim(shout ? 'shout' : 'talk');
  social.speak(agent, other, line, tone, shout ? 'shout' : 'talk');
  try {
    yield* wait(seconds);
  } finally {
    agent.body.setAnim('idle');
  }
  return ok(`${shout ? 'Le gritaste' : 'Le dijiste'} a ${other.name} (${tone}): "${line}"`);
}

function* give(ctx: ActionContext, id: string): ActionGen {
  const { agent, social } = ctx;
  const other = otherCharacter(ctx, id);
  if (typeof other === 'string') return fail(other);
  const item = agent.holding;
  if (!item) return fail('No llevas nada que regalar.');
  if (other.holding) return fail(`${other.name} ya tiene las manos ocupadas con ${other.holding.id}.`);
  const d = agent.distanceTo(other.position);
  if (d > GIVE_DISTANCE) {
    return fail(`${other.name} está a ${d.toFixed(1)} m; acércate con walk_to("${id}") para dárselo.`);
  }

  yield* turnTowards(agent, other.position);
  yield* wait(0.4);
  item.object.removeFromParent();
  other.body.holdAnchor.add(item.object);
  other.holding = item;
  agent.holding = null;
  social.gift(agent, other, item);
  yield* wait(0.4);
  return ok(`Le regalaste ${item.id} a ${other.name}.`);
}

function* avoid(ctx: ActionContext, id: string): ActionGen {
  const { agent } = ctx;
  const other = otherCharacter(ctx, id);
  if (typeof other === 'string') return fail(other);

  const limit = WORLD_HALF - 2;
  const away = Math.atan2(agent.position.x - other.position.x, agent.position.z - other.position.z);
  // De varias direcciones "lejos de él", la que más distancia deja (las paredes recortan).
  let target = new THREE.Vector3();
  let best = -Infinity;
  for (const offset of [0, 0.6, -0.6, 1.2, -1.2]) {
    const a = away + offset;
    const candidate = new THREE.Vector3(
      THREE.MathUtils.clamp(agent.position.x + Math.sin(a) * 9, -limit, limit),
      0,
      THREE.MathUtils.clamp(agent.position.z + Math.cos(a) * 9, -limit, limit),
    );
    const gap = Math.hypot(candidate.x - other.position.x, candidate.z - other.position.z);
    if (gap > best) {
      best = gap;
      target = candidate;
    }
  }
  const result = yield* walkToPoint(ctx, () => target, 0.5);
  return result.ok ? ok(`Te alejaste de ${other.name}.`) : fail(`Intentando alejarte: ${result.message}`);
}

function* pickUp(ctx: ActionContext, id: string): ActionGen {
  const { agent, world } = ctx;
  const e = world.get(id);
  if (!e || !agent.known.has(id)) return fail(`No ves ningún "${id}" por aquí.`);
  if (e.type !== 'apple') return fail(`Solo puedes recoger manzanas; ${id} es de tipo ${TYPE_NAMES[e.type]}.`);
  if (agent.holding) return fail(`Ya llevas ${agent.holding.id}; cómelo, guárdalo o suéltalo primero.`);
  const blocked = airborne(agent) ?? distanceError(agent, e);
  if (blocked) return fail(blocked);

  yield* turnTowards(agent, e.object.position);
  agent.body.setAnim('pickup', true);
  let t = 0;
  let grabbed = false;
  while (t < ANIM_DURATION.pickup) {
    t += yield;
    if (!grabbed && t >= ANIM_DURATION.pickup * 0.5) {
      world.remove(id);
      e.object.position.set(0, 0, 0);
      agent.body.holdAnchor.add(e.object);
      agent.holding = e;
      agent.known.delete(id);
      grabbed = true;
    }
  }
  agent.body.setAnim('idle');
  return ok(`Recogiste ${id}. Ahora la llevas en las manos.`);
}

function* drop(ctx: ActionContext): ActionGen {
  const { agent, world } = ctx;
  const item = agent.holding;
  if (!item) return fail('No llevas nada en las manos.');
  agent.body.setAnim('pickup', true);
  yield* wait(ANIM_DURATION.pickup * 0.5);
  const fwd = agent.forward();
  item.object.removeFromParent();
  item.object.scale.setScalar(1);
  item.object.position.set(agent.position.x + fwd.x * 0.7, 0.16, agent.position.z + fwd.z * 0.7);
  world.add(item);
  agent.holding = null;
  yield* wait(ANIM_DURATION.pickup * 0.5);
  agent.body.setAnim('idle');
  return ok(`Soltaste ${item.id} en el suelo.`);
}

function* eat(ctx: ActionContext): ActionGen {
  const { agent } = ctx;
  const item = agent.holding;
  if (!item) return fail('No tienes nada que comer en las manos. Recoge una manzana primero.');
  if (agent.hunger < MIN_HUNGER_TO_EAT) {
    return fail(`No te cabe nada más (hambre ${Math.round(agent.hunger)}). Guárdala en el cofre o déjala para luego.`);
  }
  agent.body.setAnim('eat', true);
  let t = 0;
  try {
    while (t < ANIM_DURATION.eat) {
      t += yield;
      item.object.scale.setScalar(Math.max(0.05, 1 - t / ANIM_DURATION.eat));
    }
  } finally {
    if (t < ANIM_DURATION.eat) item.object.scale.setScalar(1);
    agent.body.setAnim('idle');
  }
  item.object.removeFromParent();
  agent.holding = null;
  const before = agent.hunger;
  agent.hunger = Math.max(0, agent.hunger - 40);
  return ok(`Te comiste ${item.id}. Tu hambre bajó de ${Math.round(before)} a ${Math.round(agent.hunger)}.`);
}

function* drink(ctx: ActionContext): ActionGen {
  const { agent } = ctx;
  const pond = knownOfType(ctx, 'pond');
  if (!pond) return fail('Aún no conoces ningún sitio con agua. Explora para encontrarlo.');
  const blocked = airborne(agent) ?? distanceError(agent, pond);
  if (blocked) return fail(blocked);

  yield* turnTowards(agent, pond.object.position);
  agent.body.setAnim('drink', true);
  const before = agent.thirst;
  let t = 0;
  try {
    while (t < ANIM_DURATION.drink) {
      const dt = yield;
      t += dt;
      agent.thirst = Math.max(0, agent.thirst - (70 / ANIM_DURATION.drink) * dt);
    }
  } finally {
    agent.body.setAnim('idle');
  }
  return ok(`Bebiste del estanque. Tu sed bajó de ${Math.round(before)} a ${Math.round(agent.thirst)}.`);
}

function* putInChest(ctx: ActionContext): ActionGen {
  const { agent, world } = ctx;
  const chest = knownOfType(ctx, 'chest');
  if (!chest) return fail('Aún no has encontrado ningún cofre.');
  const item = agent.holding;
  if (!item) return fail('No llevas nada que guardar.');
  const blocked = airborne(agent) ?? distanceError(agent, chest);
  if (blocked) return fail(blocked);

  yield* turnTowards(agent, chest.object.position);
  agent.body.setAnim('pickup', true);
  yield* wait(ANIM_DURATION.pickup * 0.5);
  item.object.removeFromParent();
  agent.holding = null;
  world.chestApples += 1;
  yield* wait(ANIM_DURATION.pickup * 0.5);
  agent.body.setAnim('idle');
  return ok(`Guardaste ${item.id} en el cofre. Ahora hay ${world.chestApples} manzana(s) dentro.`);
}

function* takeFromChest(ctx: ActionContext): ActionGen {
  const { agent, world } = ctx;
  const chest = knownOfType(ctx, 'chest');
  if (!chest) return fail('Aún no has encontrado ningún cofre.');
  if (agent.holding) return fail(`Tienes las manos ocupadas con ${agent.holding.id}.`);
  if (world.chestApples <= 0) return fail('El cofre está vacío.');
  const blocked = airborne(agent) ?? distanceError(agent, chest);
  if (blocked) return fail(blocked);

  yield* turnTowards(agent, chest.object.position);
  agent.body.setAnim('pickup', true);
  yield* wait(ANIM_DURATION.pickup * 0.5);
  const apple = createApple(world.nextId('apple'));
  agent.body.holdAnchor.add(apple.object);
  agent.holding = apple;
  world.chestApples -= 1;
  yield* wait(ANIM_DURATION.pickup * 0.5);
  agent.body.setAnim('idle');
  return ok(`Sacaste ${apple.id} del cofre. Quedan ${world.chestApples}.`);
}

/** Valida que `id` sea algo conocido y al alcance. */
function nearbyEntity(ctx: ActionContext, id: string): Entity | string {
  const e = ctx.world.get(id);
  if (!e || !ctx.agent.known.has(id)) return `No ves ningún "${id}" por aquí.`;
  return distanceError(ctx.agent, e) ?? e;
}

function* examine(ctx: ActionContext, id: string): ActionGen {
  const { agent } = ctx;
  const e = nearbyEntity(ctx, id);
  if (typeof e === 'string') return fail(e);
  yield* turnTowards(agent, e.object.position);
  agent.body.setAnim('look');
  try {
    yield* wait(2);
  } finally {
    agent.body.setAnim('idle');
  }
  const other = ctx.social.agent(id);
  const detail =
    ctx.marvels.examine(agent, id) ??
    (other ? `Miras a ${other.name} de arriba abajo.` : `Es ${TYPE_NAMES[e.type]}, nada fuera de lo normal.`);
  return ok(`Examinas ${id}: ${detail}`);
}

function* touch(ctx: ActionContext, id: string): ActionGen {
  const { agent } = ctx;
  const e = nearbyEntity(ctx, id);
  if (typeof e === 'string') return fail(e);
  yield* turnTowards(agent, e.object.position);
  agent.body.setAnim('pickup', true);
  yield* wait(ANIM_DURATION.pickup * 0.5);
  const effect = ctx.marvels.touch(agent, id) ?? `Tocas ${id}. No pasa nada especial.`;
  yield* wait(ANIM_DURATION.pickup * 0.5);
  agent.body.setAnim('idle');
  return ok(effect);
}

function* levitate(ctx: ActionContext): ActionGen {
  const { agent } = ctx;
  if (!agent.powers.has('levitar')) return fail('Lo intentas con todas tus fuerzas, pero no sabes levitar.');
  if (agent.levitating) return fail('Ya estás flotando.');
  agent.levitating = true;
  agent.hasLevitated = true;
  ctx.social.announce(agent, `¡${agent.name} se eleva del suelo y se queda flotando en el aire!`);
  yield* wait(1.2);
  return ok(
    'Te elevas del suelo y flotas a metro y medio de altura. Flotando pasas por encima de rocas, del cofre ' +
      'y del estanque, pero para coger cosas o beber tendrás que bajar (land).',
  );
}

function* land(ctx: ActionContext): ActionGen {
  const { agent, world } = ctx;
  if (!agent.levitating) return fail('Ya estás con los pies en el suelo.');
  agent.levitating = false;
  yield* wait(1);
  // Si estaba sobre el estanque o una roca, aterriza en el borde.
  agent.resolveCollisions(world.solids());
  return ok('Bajas suavemente hasta el suelo.');
}

function* say(ctx: ActionContext, text: string): ActionGen {
  const { agent } = ctx;
  const line = text.trim().slice(0, 140);
  if (!line) return fail('No dijiste nada.');
  const repeated = checkNewLine(agent, line);
  if (repeated) return fail(repeated);
  const seconds = talkSeconds(line);
  agent.body.speak(line, readingSeconds(line));
  agent.body.setAnim('talk');
  ctx.social.speak(agent, null, line, 'neutral', 'say');
  try {
    yield* wait(seconds);
  } finally {
    agent.body.setAnim('idle');
  }
  return ok(`Dijiste en voz alta: "${line}"`);
}

/** Pide un deseo en voz alta; la simulación lo detecta al oírlo, como cualquier "Deseo…". */
function* makeWish(ctx: ActionContext, object: string): ActionGen {
  let thing = object
    .trim()
    .replace(/^¡?deseo\s+/i, '')
    .replace(/[!¡.]+$/, '')
    .slice(0, 60);
  if (!thing) return fail('No has dicho qué deseas.');
  if (!/^(un|una|unos|unas|el|la|los|las|mi|mis)\s/i.test(thing)) thing = `un ${thing}`;
  return yield* say(ctx, `¡Deseo ${thing}!`);
}

function* wander(ctx: ActionContext): ActionGen {
  const { agent } = ctx;
  const limit = WORLD_HALF - 2;
  // Prueba varios destinos y prefiere zonas que aún no ha visto.
  let target = new THREE.Vector3();
  let bestScore = -Infinity;
  for (let i = 0; i < 16; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 6 + Math.random() * 6;
    const x = THREE.MathUtils.clamp(agent.position.x + Math.sin(angle) * dist, -limit, limit);
    const z = THREE.MathUtils.clamp(agent.position.z + Math.cos(angle) * dist, -limit, limit);
    const candidate = new THREE.Vector3(x, 0, z);
    const score =
      (agent.explored.has(cellKey(x, z)) ? 0 : 1) +
      Math.random() * 0.5 -
      (agent.distanceTo(candidate) < 4 ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      target = candidate;
    }
  }
  const result = yield* walkToPoint(ctx, () => target, 0.5);
  return result.ok ? ok('Paseaste explorando una zona nueva.') : fail(`Mientras paseabas: ${result.message}`);
}

function* lookAround(ctx: ActionContext): ActionGen {
  const { agent } = ctx;
  const duration = 4;
  agent.body.setAnim('look');
  let t = 0;
  try {
    while (t < duration) {
      const dt = yield;
      t += dt;
      agent.heading = agent.heading + ((Math.PI * 2) / duration) * dt;
    }
  } finally {
    agent.body.setAnim('idle');
  }
  return ok('Giraste sobre ti mismo mirando a tu alrededor.');
}

function* idle(ctx: ActionContext, seconds: number): ActionGen {
  ctx.agent.body.setAnim('idle');
  const s = THREE.MathUtils.clamp(Math.round(seconds) || 3, 1, 10);
  yield* wait(s);
  return ok(`Descansaste ${s} s.`);
}

/** Crea la acción pedida por el modelo, o devuelve un error si no es válida. */
export function startAction(
  ctx: ActionContext,
  name: string,
  args: Record<string, unknown>,
): StartedAction | string {
  const id = typeof args['target_id'] === 'string' ? args['target_id'] : '';
  const text = String(args['text'] ?? '');
  const { idle: low, move, task } = PRIORITY;
  switch (name) {
    case 'walk_to':
      return { gen: walkTo(ctx, id), priority: move };
    case 'pick_up':
      return { gen: pickUp(ctx, id), priority: task };
    case 'drop':
      return { gen: drop(ctx), priority: task };
    case 'eat':
      return { gen: eat(ctx), priority: task };
    case 'drink':
      return { gen: drink(ctx), priority: task };
    case 'put_in_chest':
      return { gen: putInChest(ctx), priority: task };
    case 'take_from_chest':
      return { gen: takeFromChest(ctx), priority: task };
    case 'say':
      return { gen: say(ctx, text), priority: task };
    case 'talk_to':
      return { gen: speakTo(ctx, id, text, toTone(args['tone']), false), priority: task };
    case 'shout_to':
      return { gen: speakTo(ctx, id, text, toTone(args['tone']), true), priority: task };
    case 'give':
      return { gen: give(ctx, id), priority: task };
    case 'avoid':
      return { gen: avoid(ctx, id), priority: move };
    case 'examine':
      return { gen: examine(ctx, id), priority: task };
    case 'touch':
      return { gen: touch(ctx, id), priority: task };
    case 'levitate':
      return { gen: levitate(ctx), priority: task };
    case 'wish':
      return { gen: makeWish(ctx, String(args['objeto'] ?? '')), priority: task };
    case 'land':
      return { gen: land(ctx), priority: task };
    case 'wander':
      return { gen: wander(ctx), priority: low };
    case 'look_around':
      return { gen: lookAround(ctx), priority: low };
    case 'idle':
      return { gen: idle(ctx, Number(args['seconds'] ?? 3)), priority: low };
    default:
      return `La acción "${name}" no existe.`;
  }
}

/** Texto corto para el registro, p. ej. `walk_to(apple-3)`. */
export function describeAction(name: string, args: Record<string, unknown>): string {
  if (name === 'talk_to' || name === 'shout_to') {
    return `${name}(${String(args['target_id'])}, ${String(args['tone'])})`;
  }
  if (typeof args['target_id'] === 'string') return `${name}(${args['target_id']})`;
  if (typeof args['text'] === 'string') return `${name}("${args['text']}")`;
  if (typeof args['objeto'] === 'string') return `${name}("${args['objeto']}")`;
  if (args['seconds'] !== undefined) return `${name}(${String(args['seconds'])} s)`;
  return `${name}()`;
}

function tool(name: string, description: string, props: Record<string, unknown> = {}): ChatTool {
  return {
    type: 'function',
    function: {
      name,
      description,
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          reasoning: {
            type: 'string',
            description: 'Tu pensamiento interno, breve (máx. 20 palabras), en primera persona.',
          },
          ...props,
        },
        required: ['reasoning', ...Object.keys(props)],
        additionalProperties: false,
      },
    },
  };
}

const targetId = { target_id: { type: 'string', description: 'Id del objeto, p. ej. "apple-3".' } };
const characterId = { target_id: { type: 'string', description: 'Id del personaje.' } };
const speech = {
  ...characterId,
  text: { type: 'string', description: 'Lo que le dices: una o dos frases cortas (máx. 25 palabras).' },
  tone: { type: 'string', enum: [...TONES], description: 'El tono real de tu frase.' },
};

export const TOOLS: ChatTool[] = [
  tool('walk_to', 'Camina hasta un objeto o personaje que hayas visto, por su id. Necesario antes de interactuar.', targetId),
  tool('talk_to', `Dile algo a otro personaje que esté a menos de ${TALK_DISTANCE} m.`, speech),
  tool(
    'shout_to',
    `Grítale algo a otro personaje que esté lejos (hasta ${SHOUT_DISTANCE} m), aunque no lo veas. ` +
      'Sirve para llamarle, seguir una conversación a distancia o discutir a voces.',
    speech,
  ),
  tool('give', 'Regala la manzana que llevas a otro personaje que esté a tu lado. Mejora mucho la relación.', characterId),
  tool('avoid', 'Aléjate de otro personaje, por ejemplo si estáis peleados.', characterId),
  tool('examine', 'Examina de cerca algo que tengas al alcance para descubrir más detalles.', targetId),
  tool('touch', 'Toca algo que tengas al alcance. Con objetos extraños puede pasar cualquier cosa.', targetId),
  tool('wish', 'Pide un deseo en voz alta ("¡Deseo …!"). Si la magia está cargada, lo deseado aparece a tu lado.', {
    objeto: { type: 'string', description: 'Lo que deseas, con artículo: p. ej. "una guitarra eléctrica".' },
  }),
  tool('levitate', 'Elévate y flota en el aire (solo si tienes el poder de levitar).'),
  tool('land', 'Deja de levitar y baja al suelo.'),
  tool('pick_up', 'Recoge una manzana que esté a tu alcance (~1 m). Solo puedes llevar una cosa a la vez.', targetId),
  tool('drop', 'Suelta en el suelo lo que llevas en las manos.'),
  tool('eat', `Cómete la manzana que llevas en las manos. Baja el hambre 40 puntos. Solo si tu hambre es ${MIN_HUNGER_TO_EAT} o más.`),
  tool('drink', 'Bebe agua del estanque. Tienes que estar en su orilla. Baja mucho la sed.'),
  tool('put_in_chest', 'Guarda en el cofre la manzana que llevas. Tienes que estar junto al cofre.'),
  tool('take_from_chest', 'Saca una manzana del cofre. Tienes que estar junto al cofre y con las manos libres.'),
  tool('say', 'Habla solo en voz alta, sin dirigirte a nadie (quien esté cerca lo oye). Frases cortas.', {
    text: { type: 'string', description: 'Lo que dices.' },
  }),
  tool('wander', 'Camina hacia una zona cercana al azar para explorar.'),
  tool('look_around', 'Gira sobre ti mismo para ver qué hay alrededor.'),
  tool('idle', 'Descansa sin hacer nada unos segundos.', {
    seconds: { type: 'integer', description: 'Segundos, entre 1 y 10.' },
  }),
];
