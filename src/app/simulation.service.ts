import { computed, inject, Injectable, isDevMode, signal } from '@angular/core';
import * as THREE from 'three';
import { ActionContext, stopDistance, walkToPoint } from './agent/actions';
import { Agent, AGENT_RADIUS } from './agent/agent';
import { Brain, BrainLogKind } from './agent/brain';
import { LongTermMemory } from './agent/memory';
import {
  canSeePoint,
  markExplored,
  perceive,
  Perceived,
  soundDirection,
  VIEW_DISTANCE,
  VIEW_FOV,
} from './agent/perception';
import {
  CharacterProfile,
  loadSetup,
  saveSetup,
  SimulationSetup,
  slugify,
  STARTING_RELATIONS,
} from './agent/profile';
import {
  GIFT_DELTA,
  HEAR_DISTANCE,
  HEARD_DELTA,
  Relation,
  relationLabel,
  SHOUT_DISTANCE,
  SocialHub,
  SpeechMode,
  SPOKEN_DELTA,
  Tone,
} from './agent/social';
import { OpenAiService } from './core/openai.service';
import { Stage } from './scene/stage';
import { Entity, TYPE_NAMES } from './world/entities';
import { MarvelSystem } from './world/marvels';
import { WishSystem } from './world/wishes';
import { World } from './world/world';

const MAX_LOG = 120;
const SENSE_INTERVAL = 0.25;
const SPAWN_POINTS = [
  { x: -2, z: 0, heading: Math.PI / 2 },
  { x: 2, z: 0, heading: -Math.PI / 2 },
];

export type LogKind = BrainLogKind | 'event' | 'talk';

export interface LogEntry {
  id: number;
  time: number;
  kind: LogKind;
  text: string;
  who?: string;
  color?: string;
  tone?: Tone;
}

export interface CharacterView {
  id: string;
  name: string;
  color: string;
  hunger: number;
  thirst: number;
  holding: string | null;
  action: string;
  thought: string;
  thinking: boolean;
  angry: boolean;
  powers: string[];
  levitating: boolean;
  relations: { name: string; affinity: number; label: Relation }[];
  memory: {
    interests: string[];
    opinions: { name: string; text: string }[];
    items: { text: string; old: boolean }[];
    nextTopics: string[];
  };
}

/** Estado de un personaje dentro de la simulación. */
interface Character {
  profile: CharacterProfile;
  agent: Agent;
  brain: Brain;
  entity: Entity;
  cone: THREE.Mesh;
  visible: Perceived[];
  needAlerts: { hunger: boolean; thirst: boolean };
  /** Última etiqueta de relación vista con cada personaje, para avisar de cambios. */
  relations: Map<string, Relation>;
  thought: string;
  thinking: boolean;
}

/** Une escena, mundo y personajes, y expone su estado al HUD con signals. */
@Injectable({ providedIn: 'root' })
export class SimulationService {
  private readonly openai = inject(OpenAiService);
  readonly hasApiKey = this.openai.hasKey;
  readonly modelName = this.openai.model;

  readonly phase = signal<'setup' | 'running'>('setup');
  readonly setup = signal<SimulationSetup>(loadSetup());
  readonly characters = signal<CharacterView[]>([]);
  readonly chestApples = signal(0);
  readonly log = signal<LogEntry[]>([]);
  readonly brainRunning = signal(false);
  readonly usage = signal({ calls: 0, input: 0, output: 0 });
  /** Coste estimado en USD (con caché y tarifa por horas), o null si no se conoce la tarifa del modelo. */
  readonly cost = this.openai.spent.asReadonly();
  readonly debug = signal(false);
  readonly follow = signal(true);
  readonly subtitles = signal(true);
  readonly fatal = signal<string | null>(null);
  /** Si los objetos imposibles están ahora mismo en el claro. */
  readonly marvelsVisible = signal(false);
  /** Personaje que se mueve a mano con clics cuando la IA está en pausa. */
  readonly selected = signal(0);
  readonly anyThinking = computed(() => this.characters().some((c) => c.thinking));

  private stage: Stage | null = null;
  private readonly world = new World();
  private cast: Character[] = [];
  private time = 0;
  private senseTimer = 0;
  private uiTimer = 0;
  private logId = 0;
  /** Cambia en cada start(): una preparación que llega tarde no arranca nada. */
  private runId = 0;

  private readonly social: SocialHub = {
    agent: (id) => this.byId(id)?.agent,
    others: (self) => this.cast.filter((c) => c.agent !== self).map((c) => c.agent),
    speak: (from, to, text, tone, mode) => this.onSpeak(from, to, text, tone, mode),
    gift: (from, to, item) => this.onGift(from, to, item),
    announce: (from, text) => {
      for (const c of this.cast) {
        if (c.agent === from || !canSeePoint(c.agent, from.position, VIEW_DISTANCE)) continue;
        c.brain.remember(text);
        this.addLog('event', text, c);
        if (this.brainRunning()) c.agent.interrupt(text, 0);
      }
    },
  };

  private readonly marvels = new MarvelSystem({
    characters: () => this.cast.map((c) => c.agent),
    memoryOf: (id) => this.byId(id)?.brain.memory,
    tell: (id, text, urgent) => {
      const c = this.byId(id);
      if (!c) return;
      c.brain.remember(text);
      this.addLog('event', text, c);
      if (urgent && this.brainRunning()) c.agent.interrupt(text, 0);
    },
  });

  private readonly wishes = new WishSystem(this.openai, this.marvels, {
    time: () => this.time,
    log: (agent, text) => this.addLog('memory', text, this.byId(agent.id)),
    tell: (agent, text) => {
      const c = this.byId(agent.id);
      if (!c) return;
      c.brain.remember(text);
      this.addLog('event', text, c);
    },
    announce: (agent, text) => this.social.announce(agent, text),
    usage: (input, output) =>
      this.usage.update((u) => ({ calls: u.calls + 1, input: u.input + input, output: u.output + output })),
  });

  init(host: HTMLElement): void {
    if (this.stage) return;
    const stage = new Stage(host);
    this.stage = stage;
    stage.scene.add(this.world.root);
    stage.pickables = [stage.ground, this.world.root];
    stage.onClick = (hit) => this.handleClick(hit);
    this.world.generate();
    stage.start((dt) => this.tick(dt));
    // Acceso desde la consola del navegador para depurar (solo en desarrollo).
    if (isDevMode()) Object.assign(window, { pip: this });
  }

  destroy(): void {
    this.stopBrains();
    this.stage?.dispose();
    this.stage = null;
  }

  /** Arranca la simulación con los personajes definidos en la pantalla inicial. */
  async start(setup: SimulationSetup): Promise<void> {
    const run = ++this.runId;
    saveSetup(setup);
    this.setup.set(setup);
    this.log.set([]);
    this.fatal.set(null);
    this.marvels.clear();
    this.wishes.reset();
    this.world.generate();
    this.spawnCharacters(setup);
    if (setup.marvels) this.marvels.spawn(this.world, this.cast.map((c) => c.agent));
    this.marvelsVisible.set(this.marvels.active);
    this.phase.set('running');
    this.addLog('info', `Empieza la simulación con ${this.cast.map((c) => c.profile.name).join(' y ')}.`);
    for (const c of this.cast) {
      const old = c.brain.memory.previousCount;
      if (old) this.addLog('memory', `Recuerda ${old} cosas de otras veces.`, c);
    }
    if (!this.hasApiKey) return;

    // La ficha ampliada (intereses, manías, pasado) se crea una vez y queda guardada.
    if (this.cast.some((c) => !c.brain.memory.card)) this.addLog('info', 'Preparando a los personajes…');
    await Promise.all(this.cast.map((c) => c.brain.prepare()));
    if (run !== this.runId || this.phase() !== 'running') return;
    for (const c of this.cast) {
      const card = c.brain.memory.card;
      if (card) this.addLog('memory', `Le apasiona: ${card.interests.join(', ')}.`, c);
    }
    this.startBrains();
  }

  /** Vuelve a la pantalla de personajes. */
  editCharacters(): void {
    this.runId++;
    this.stopBrains();
    this.removeCharacters();
    this.marvels.clear();
    this.marvelsVisible.set(false);
    this.world.generate();
    this.characters.set([]);
    this.phase.set('setup');
  }

  resetWorld(): void {
    void this.start(this.setup());
  }

  toggleBrain(): void {
    if (this.brainRunning()) {
      this.stopBrains();
      this.addLog('info', 'IA en pausa. Cada personaje terminará lo que estaba haciendo.');
    } else {
      this.fatal.set(null);
      this.startBrains();
      this.addLog('info', 'IA en marcha.');
    }
  }

  step(): void {
    for (const c of this.cast) void c.brain.step();
  }

  toggleDebug(): void {
    this.debug.update((v) => !v);
    this.world.setLabelsVisible(this.debug());
    for (const c of this.cast) c.cone.visible = this.debug();
  }

  toggleFollow(): void {
    this.follow.update((v) => !v);
  }

  toggleSubtitles(): void {
    this.subtitles.update((v) => !v);
  }

  /** Hace aparecer o desaparecer los objetos imposibles en plena partida. */
  toggleMarvels(): void {
    if (this.marvels.active) {
      const ids = this.marvels.ids();
      this.marvels.removeAll(this.world);
      for (const c of this.cast) for (const id of ids) c.agent.known.delete(id);
      this.addLog('info', 'Los objetos imposibles han desaparecido del claro.');
    } else {
      this.marvels.spawn(this.world, this.cast.map((c) => c.agent));
      this.addLog('info', 'Han aparecido objetos imposibles en el claro…');
    }
    this.marvelsVisible.set(this.marvels.active);
  }

  select(index: number): void {
    this.selected.set(index);
  }

  private startBrains(): void {
    this.brainRunning.set(true);
    for (const c of this.cast) c.brain.start();
  }

  private stopBrains(): void {
    this.brainRunning.set(false);
    for (const c of this.cast) c.brain.stop();
  }

  private byId(id: string): Character | undefined {
    return this.cast.find((c) => c.agent.id === id);
  }

  private spawnCharacters(setup: SimulationSetup): void {
    this.stopBrains();
    this.removeCharacters();
    const taken = new Set<string>();
    const start = STARTING_RELATIONS.find((r) => r.value === setup.relation) ?? STARTING_RELATIONS[1];

    this.cast = setup.characters.map((profile, i) => {
      const otherNames = setup.characters.filter((_, j) => j !== i).map((c) => c.name.trim());
      const backstory = start.backstory.replace('{other}', otherNames.join(' y '));
      const id = slugify(profile.name, taken);
      taken.add(id);
      const agent = new Agent(id, profile.name.trim() || id, profile.color);
      const spawn = SPAWN_POINTS[i % SPAWN_POINTS.length];
      agent.reset(spawn.x, spawn.z, spawn.heading);
      this.stage?.scene.add(agent.body.root);

      const entity: Entity = {
        id,
        type: 'character',
        object: agent.body.root,
        radius: AGENT_RADIUS,
        solid: true,
        occluders: [],
      };
      this.world.addCharacter(entity);
      const cone = createViewCone();
      cone.visible = this.debug();
      agent.body.root.add(cone);

      const ctx: ActionContext = { agent, world: this.world, social: this.social, marvels: this.marvels };
      const memory = LongTermMemory.load(id, setup.keepMemories !== false);
      // `character` se usa en los hooks, que solo se llaman después de crearlo.
      let character!: Character;
      const options = { wishes: setup.wishes !== false };
      const brain = new Brain(this.openai, ctx, profile, backstory, memory, options, () => this.time, () => character.visible, {
        memoryChanged: () => memory.save(),
        log: (kind, text) => this.addLog(kind, text, character),
        usage: (input, output) =>
          this.usage.update((u) => ({ calls: u.calls + 1, input: u.input + input, output: u.output + output })),
        thinking: (on) => {
          character.thinking = on;
          agent.body.setThinking(on);
        },
        thought: (text) => (character.thought = text),
        fatal: (message) => {
          this.fatal.set(message);
          this.stopBrains();
        },
      });
      character = {
        profile,
        agent,
        brain,
        entity,
        cone,
        visible: [],
        needAlerts: { hunger: false, thirst: false },
        relations: new Map(),
        thought: 'Todavía no he pensado nada.',
        thinking: false,
      };
      return character;
    });

    for (const a of this.cast) {
      for (const b of this.cast) {
        if (a === b) continue;
        a.agent.affinity.set(b.agent.id, start.affinity);
        a.relations.set(b.agent.id, relationLabel(start.affinity));
      }
    }
    this.selected.set(0);
    this.syncUi();
  }

  private removeCharacters(): void {
    for (const c of this.cast) {
      c.agent.cancel('Fin de la simulación.');
      c.agent.holding?.object.removeFromParent();
      c.agent.body.dispose();
      this.world.removeCharacter(c.agent.id);
    }
    this.cast = [];
  }

  private tick(dt: number): void {
    this.time += dt;
    this.world.update(dt);
    this.marvels.update(dt);
    for (const c of this.cast) c.agent.update(dt);

    this.senseTimer += dt;
    if (this.senseTimer >= SENSE_INTERVAL) {
      this.senseTimer = 0;
      for (const c of this.cast) this.sense(c);
    }
    if (this.follow() && this.cast.length) {
      const center = new THREE.Vector3();
      for (const c of this.cast) center.add(c.agent.position);
      this.stage?.follow(center.divideScalar(this.cast.length), dt);
    }

    this.uiTimer += dt;
    if (this.uiTimer >= 0.2) {
      this.uiTimer = 0;
      this.syncUi();
    }
  }

  private syncUi(): void {
    this.chestApples.set(this.world.chestApples);
    this.characters.set(
      this.cast.map((c) => ({
        id: c.agent.id,
        name: c.agent.name,
        color: c.profile.color,
        hunger: Math.round(c.agent.hunger),
        thirst: Math.round(c.agent.thirst),
        holding: c.agent.holding?.id ?? null,
        action: c.agent.actionLabel ?? '—',
        thought: c.thought,
        thinking: c.thinking,
        angry: c.agent.angry,
        powers: [...c.agent.powers],
        levitating: c.agent.levitating,
        relations: this.social.others(c.agent).map((o) => {
          const affinity = Math.round(c.agent.getAffinity(o.id));
          return { name: o.name, affinity, label: relationLabel(affinity) };
        }),
        memory: this.memoryView(c),
      })),
    );
  }

  private memoryView(c: Character): CharacterView['memory'] {
    const m = c.brain.memory;
    return {
      interests: m.card?.interests ?? [],
      opinions: this.social
        .others(c.agent)
        .filter((o) => m.opinions.has(o.id))
        .map((o) => ({ name: o.name, text: m.opinions.get(o.id)! })),
      items: m.items
        .slice()
        .reverse()
        .map((i) => ({ text: i.text, old: i.session !== m.session })),
      nextTopics: m.nextTopics,
    };
  }

  /** Percepción periódica: actualiza la memoria espacial y genera sucesos. */
  private sense(c: Character): void {
    const { agent, brain } = c;
    const world = this.world;
    c.visible = perceive(agent, world);
    markExplored(agent);
    const seenIds = new Set<string>();

    for (const { entity: e, distance, direction } of c.visible) {
      seenIds.add(e.id);
      const isNew = !agent.known.has(e.id);
      agent.known.set(e.id, { id: e.id, type: e.type, position: e.object.position.clone(), lastSeen: this.time });
      if (!isNew || e.type === 'tree' || e.type === 'rock') continue;

      const other = this.byId(e.id);
      const text = other
        ? `Ves a ${other.agent.name} (id: ${e.id}) ${direction}, a ${distance} m.`
        : e.type === 'marvel'
          ? `Ves algo que no debería existir (${e.id}) ${direction}, a ${distance} m: ${this.marvels.describe(agent, e.id)}`
          : `Descubres ${e.id} (${TYPE_NAMES[e.type]}) ${direction}, a ${distance} m.`;
      brain.remember(text);
      this.addLog('event', text, c);
      if ((e.type === 'apple' || e.type === 'marvel') && this.brainRunning()) {
        agent.interrupt('Te detienes: has visto algo.', 0);
      }
    }

    // Manzanas recordadas que ya no están donde deberían verse.
    for (const k of [...agent.known.values()]) {
      if (k.type !== 'apple' || seenIds.has(k.id) || world.get(k.id)) continue;
      if (canSeePoint(agent, k.position, 8)) {
        agent.known.delete(k.id);
        brain.remember(`${k.id} ya no está donde la viste.`);
      }
    }
    if (this.debug() && c === this.cast[this.selected()]) world.markVisible(seenIds);

    this.checkNeed(c, 'hunger', 'Te ruge el estómago: tienes mucha hambre.');
    this.checkNeed(c, 'thirst', 'Tienes la boca seca: tienes mucha sed.');
    this.checkRelations(c);
  }

  private checkNeed(c: Character, need: 'hunger' | 'thirst', text: string): void {
    const value = c.agent[need];
    if (value >= 70 && !c.needAlerts[need]) {
      c.needAlerts[need] = true;
      c.brain.remember(text);
      this.addLog('event', text, c);
      if (this.brainRunning()) c.agent.interrupt(text, 0);
    } else if (value < 50) {
      c.needAlerts[need] = false;
    }
  }

  /** Avisa cuando cambia la relación de un personaje con otro (incluido el enfriamiento con el tiempo). */
  private checkRelations(c: Character): void {
    for (const other of this.cast) {
      if (other === c) continue;
      const label = relationLabel(c.agent.getAffinity(other.agent.id));
      const before = c.relations.get(other.agent.id);
      if (label === before) continue;
      c.relations.set(other.agent.id, label);
      const name = other.agent.name;
      const text =
        label === 'peleados'
          ? `Estás muy enfadado con ${name}: ahora estáis peleados.`
          : before === 'peleados'
            ? `Se te ha pasado un poco el enfado con ${name} (ahora: ${label}).`
            : `Tu relación con ${name} ha cambiado: ahora ${label}.`;
      c.brain.remember(text);
      this.addLog('event', text, c);
    }
  }

  private onSpeak(from: Agent, to: Agent | null, text: string, tone: Tone, mode: SpeechMode): void {
    const speaker = this.byId(from.id);
    if (!speaker) return;

    // "Deseo un/una…" dicho en voz alta puede hacerse realidad.
    const wish = this.setup().wishes !== false ? WishSystem.detect(text) : null;
    if (wish && !this.wishes.request(from, wish, this.world)) {
      speaker.brain.remember('Pides un deseo, pero la magia aún no se ha recargado. Espera un poco antes de pedir otro.');
    }

    if (!to) {
      this.addLog('talk', `(en voz alta) "${text}"`, speaker, tone);
      for (const c of this.cast) {
        if (c === speaker || c.agent.distanceTo(from.position) > HEAR_DISTANCE) continue;
        c.brain.hear(`Oyes a ${from.name} decir en voz alta: "${text}"`);
      }
      return;
    }

    const listener = this.byId(to.id);
    if (!listener) return;
    const shout = mode === 'shout';
    to.changeAffinity(from.id, HEARD_DELTA[tone]);
    from.changeAffinity(to.id, SPOKEN_DELTA[tone]);
    speaker.brain.noteSaid(`Tú ${shout ? 'le gritas' : 'a'} ${to.name} (${tone}): "${text}"`, to.id);

    if (shout) {
      // Por la voz sabe de dónde viene, aunque no le vea.
      const d = Math.round(to.distanceTo(from.position));
      const where = soundDirection(to, from.position);
      to.known.set(from.id, { id: from.id, type: 'character', position: from.position.clone(), lastSeen: this.time });
      listener.brain.hear(`${from.name} te grita desde unos ${d} m, ${where} (${tone}): "${text}"`, from.id);
    } else {
      listener.brain.hear(`${from.name} te dice (${tone}): "${text}"`, from.id, true);
    }
    to.lookAt(from.position, 6);
    // Un grito solo corta paseos y esperas; si no, nadie llegaría nunca a ningún sitio.
    to.interrupt(`${from.name} te está ${shout ? 'gritando' : 'hablando'}.`, shout ? 0 : 1);
    listener.brain.wake();
    this.addLog('talk', `${shout ? '📢' : '→'} ${to.name}: "${text}"`, speaker, tone);

    // Los demás también oyen los gritos.
    if (!shout) return;
    for (const c of this.cast) {
      if (c === speaker || c === listener || c.agent.distanceTo(from.position) > SHOUT_DISTANCE) continue;
      c.brain.hear(`Oyes a ${from.name} gritarle a ${to.name}: "${text}"`);
    }
  }

  private onGift(from: Agent, to: Agent, item: Entity): void {
    const giver = this.byId(from.id);
    const receiver = this.byId(to.id);
    if (!giver || !receiver) return;
    to.changeAffinity(from.id, GIFT_DELTA.received);
    from.changeAffinity(to.id, GIFT_DELTA.given);
    receiver.brain.hear(`${from.name} te ha regalado ${item.id}. Ahora la llevas en las manos.`);
    to.lookAt(from.position, 4);
    to.interrupt(`${from.name} te ha dado algo.`, 1);
    receiver.brain.wake();
    this.addLog('event', `Regala ${item.id} a ${to.name}.`, giver);
  }

  /** Control manual con la IA en pausa: clic en el suelo o en un objeto. */
  private handleClick(hit: THREE.Intersection): void {
    const c = this.cast[this.selected()];
    if (!c) return;
    if (this.brainRunning()) {
      this.addLog('info', 'Pausa la IA para mover a los personajes a mano.');
      return;
    }
    const entity = this.entityFrom(hit.object);
    const point = hit.point.clone();
    const ctx: ActionContext = { agent: c.agent, world: this.world, social: this.social, marvels: this.marvels };
    const gen = entity
      ? walkToPoint(ctx, () => entity.object.position, stopDistance(entity), entity.id)
      : walkToPoint(ctx, () => point, 0.15);
    const label = entity ? `ir a ${entity.id} (manual)` : 'caminar (manual)';
    void c.agent.run(label, gen).then((r) => {
      if (r.ok || !r.message.startsWith('Interrumpida')) this.addLog(r.ok ? 'result' : 'fail', r.message, c);
    });
  }

  private entityFrom(object: THREE.Object3D): Entity | undefined {
    for (let o: THREE.Object3D | null = object; o; o = o.parent) {
      const id = o.userData['entityId'];
      if (typeof id === 'string') return this.world.get(id);
    }
    return undefined;
  }

  private addLog(kind: LogKind, text: string, who?: Character, tone?: Tone): void {
    const entry: LogEntry = {
      id: ++this.logId,
      time: Math.round(this.time),
      kind,
      text,
      who: who?.agent.name,
      color: who?.profile.color,
      tone,
    };
    this.log.update((list) => [entry, ...list].slice(0, MAX_LOG));
  }
}

/** Sector semitransparente que muestra el campo de visión (modo depuración). */
function createViewCone(): THREE.Mesh {
  const cone = new THREE.Mesh(
    new THREE.CircleGeometry(VIEW_DISTANCE, 40, -Math.PI / 2 - VIEW_FOV / 2, VIEW_FOV),
    new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.15, depthWrite: false }),
  );
  cone.rotation.x = -Math.PI / 2;
  cone.position.y = 0.04;
  cone.visible = false;
  return cone;
}
