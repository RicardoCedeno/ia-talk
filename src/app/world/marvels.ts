import * as THREE from 'three';
import type { Agent } from '../agent/agent';
import { AgentBody } from '../agent/agent-body';
import type { LongTermMemory } from '../agent/memory';
import { canSeePoint, VIEW_DISTANCE } from '../agent/perception';
import { Entity } from './entities';
import { World } from './world';

/** Lo que las acciones (examine, touch) y el prompt necesitan de los objetos imposibles. */
export interface MarvelApi {
  /** Lo que se ve a simple vista (puede depender de quién mira). */
  describe(viewer: Agent, id: string): string | undefined;
  /** Lo que se descubre al examinarlo de cerca. */
  examine(viewer: Agent, id: string): string | undefined;
  /** Efecto de tocarlo; devuelve lo que siente quien lo toca. */
  touch(agent: Agent, id: string): string | undefined;
}

/** Lo que los objetos necesitan de la simulación. */
export interface MarvelHost {
  characters(): Agent[];
  memoryOf(id: string): LongTermMemory | undefined;
  /** Cuenta un suceso a un personaje; `urgent` corta paseos y esperas. */
  tell(agentId: string, text: string, urgent: boolean): void;
}

export interface Marvel {
  readonly entity: Entity;
  describe(viewer: Agent): string;
  examine(viewer: Agent): string;
  touch(agent: Agent): string;
  update(dt: number): void;
  dispose?(): void;
  /** Se ha gastado al tocarlo (p. ej. comida) y debe desaparecer. */
  readonly consumed?: boolean;
}

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];

/** Quienes ven ahora mismo un punto (para avisar de lo que acaba de pasar). */
function witnesses(host: MarvelHost, point: THREE.Vector3, except: Agent): Agent[] {
  return host.characters().filter((c) => c !== except && canSeePoint(c, point, VIEW_DISTANCE));
}

const CRYPTIC = [
  '«Las manzanas recuerdan quién las arrancó.»',
  '«Alguien en este claro no es quien dice ser.»',
  '«La puerta no lleva a donde crees.»',
  '«La estatua sabe tu nombre.»',
  '«Esta noche faltará una estrella. Pregunta quién se la llevó.»',
  '«Lo que guardas en el cofre no es solo tuyo.»',
];

/** Una esfera de luz que flota sola y susurra cosas que no debería saber. */
class WhisperingOrb implements Marvel {
  readonly entity: Entity;
  private readonly floater = new THREE.Group();
  private readonly core: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  private readonly ring: THREE.Mesh;
  private readonly light = new THREE.PointLight(0xa070ff, 3, 7);
  private time = Math.random() * 10;
  private flash = 0;
  private whisperTimer = 0;

  constructor(private readonly host: MarvelHost) {
    this.core = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 24, 16),
      new THREE.MeshStandardMaterial({ color: 0xb48cff, emissive: 0x8a4dff, emissiveIntensity: 1.2, roughness: 0.2 }),
    );
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.03, 8, 48),
      new THREE.MeshStandardMaterial({ color: 0xe0d0ff, emissive: 0xb48cff, emissiveIntensity: 0.8 }),
    );
    this.floater.add(this.core, this.ring, this.light);
    this.floater.position.y = 1.4;
    const group = new THREE.Group();
    group.add(this.floater);
    this.entity = { id: 'orb-1', type: 'marvel', object: group, radius: 0.35, solid: false, occluders: [] };
  }

  describe(): string {
    return 'Una esfera de luz violeta que flota sola en el aire, girando y zumbando bajito.';
  }

  examine(): string {
    return (
      'De cerca oyes voces dentro, como si mucha gente susurrara a la vez. Tienes la sensación de que, ' +
      'si la tocas, te contará algo que no deberías saber… y de que algo en ti cambiará.'
    );
  }

  touch(agent: Agent): string {
    this.flash = 1;
    const gift = this.grantLevitation(agent);
    const other = pick(this.host.characters().filter((c) => c !== agent));
    const options: string[] = [];
    if (other) {
      const memory = this.host.memoryOf(other.id);
      const opinion = memory?.opinions.get(agent.id);
      if (opinion) options.push(`«${other.name} piensa esto de ti: "${opinion}"»`);
      if (memory?.card?.secret) options.push(`«El secreto de ${other.name}: ${memory.card.secret}»`);
    }
    const whisper = options.length ? pick(options) : pick(CRYPTIC);
    return `La esfera se ilumina de golpe y te susurra al oído: ${whisper}${gift}`;
  }

  /** La primera vez que alguien la toca, le da el poder de levitar. */
  private grantLevitation(agent: Agent): string {
    if (agent.powers.has('levitar')) return '';
    agent.powers.add('levitar');
    for (const w of witnesses(this.host, agent.position, agent)) {
      this.host.tell(w.id, `La esfera envuelve a ${agent.name} en una luz violeta. Algo le ha pasado.`, true);
    }
    return (
      ' Luego la luz te envuelve y sientes un cosquilleo por todo el cuerpo: ¡te has vuelto ligero como una pluma! ' +
      'Ahora tienes el poder de levitar (levitate) y bajar (land) cuando quieras. ¡Pruébalo!'
    );
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    this.floater.position.y = 1.4 + Math.sin(t * 1.5) * 0.12;
    this.ring.rotation.set(t * 0.9, t * 0.6, 0);
    this.flash = Math.max(0, this.flash - dt * 0.7);
    this.core.material.emissiveIntensity = 1.1 + Math.sin(t * 3) * 0.3 + this.flash * 3;
    this.light.intensity = 3 + this.flash * 12;

    // De vez en cuando susurra a quien esté cerca, sin que nadie la toque.
    this.whisperTimer += dt;
    if (this.whisperTimer < 25) return;
    this.whisperTimer = 0;
    for (const c of this.host.characters()) {
      if (c.distanceTo(this.entity.object.position) < 3) {
        this.host.tell(c.id, `Oyes que la esfera flotante susurra: ${pick(CRYPTIC)}`, false);
      }
    }
  }
}

/** Una puerta sin pared en mitad de la hierba; quien la cruza aparece en otra parte. */
class DoorToNowhere implements Marvel {
  readonly entity: Entity;
  private readonly pivot = new THREE.Group();
  private readonly glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private swing = 0;
  private time = 0;

  constructor(
    private readonly host: MarvelHost,
    private readonly world: World,
  ) {
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.8 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x5e3b20, roughness: 0.8 });
    const post = new THREE.BoxGeometry(0.14, 2.45, 0.16);
    const left = new THREE.Mesh(post, frameMat);
    left.position.set(-0.63, 1.22, 0);
    const right = left.clone();
    right.position.x = 0.63;
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.14, 0.16), frameMat);
    top.position.y = 2.45;

    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.12, 2.32, 0.07), wood);
    panel.position.x = 0.56;
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xe8c547, metalness: 0.7, roughness: 0.3 }),
    );
    knob.position.set(1, 0, 0.06);
    panel.add(knob);
    this.pivot.position.set(-0.56, 1.17, 0);
    this.pivot.add(panel);

    this.glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.12, 2.32),
      new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    this.glow.position.set(0, 1.17, -0.02);

    const group = new THREE.Group();
    group.add(left, right, top, this.pivot, this.glow);
    group.rotation.y = Math.random() * Math.PI * 2;
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o !== this.glow) o.castShadow = true;
    });
    this.entity = { id: 'door-1', type: 'marvel', object: group, radius: 0.75, solid: true, occluders: [] };
  }

  describe(): string {
    return (
      'Una puerta de madera de pie en mitad de la hierba. No hay pared ni casa, solo la puerta, ' +
      'y por la rendija sale una luz dorada.'
    );
  }

  examine(): string {
    return (
      'Rodeas la puerta: por detrás no hay nada, solo hierba. Pero por la rendija se ve otro lugar, ' +
      'iluminado y lejano. El picaporte está caliente.'
    );
  }

  touch(agent: Agent): string {
    const from = agent.position.clone();
    let destination: THREE.Vector3 | null = null;
    for (let i = 0; i < 20 && !destination; i++) {
      const spot = this.world.freeSpot(0.5, 0.6, 0);
      if (spot && spot.distanceTo(from) >= 12) destination = spot;
    }
    if (!destination) return 'Giras el picaporte, pero la puerta no se abre.';

    const sawLeave = witnesses(this.host, from, agent);
    agent.position.copy(destination);
    agent.heading = Math.random() * Math.PI * 2;
    this.swing = 1;

    for (const w of sawLeave) {
      this.host.tell(w.id, `Ves a ${agent.name} abrir la puerta imposible, cruzarla… y desaparecer en un destello dorado.`, true);
    }
    for (const w of witnesses(this.host, destination, agent)) {
      if (!sawLeave.includes(w)) this.host.tell(w.id, `¡${agent.name} aparece de la nada en un destello dorado!`, true);
    }
    const back = Math.round(destination.distanceTo(this.entity.object.position));
    return (
      `Abres la puerta y la cruzas. Todo da vueltas… y apareces de golpe en otra parte del claro ` +
      `(${destination.x.toFixed(0)}, ${destination.z.toFixed(0)}). La puerta ha quedado a ${back} m.`
    );
  }

  update(dt: number): void {
    this.time += dt;
    this.swing = Math.max(0, this.swing - dt * 0.6);
    this.pivot.rotation.y = -0.3 - this.swing * 1.3;
    this.glow.material.opacity = 0.7 + Math.sin(this.time * 2) * 0.15 + this.swing * 0.15;
  }
}

const EPITHETS = [
  'el ser más sabio y hermoso de este claro',
  'que un día traicionará a todos',
  'guardián del claro… por desgracia',
  'a quien nadie quiso escuchar a tiempo',
  'futuro rey del bosque',
];

/** Una estatua idéntica a uno de los personajes, que se gira para mirar a quien tenga más cerca. */
class UncannyStatue implements Marvel {
  readonly entity: Entity;
  private readonly body: AgentBody;
  private readonly inscription: string;

  constructor(
    private readonly host: MarvelHost,
    private readonly subject: Agent,
  ) {
    this.body = new AgentBody('#a9a59b', '', { skin: '#bdb8ac', roughness: 0.95 });
    this.body.setNameVisible(false);
    this.body.setAnim('talk');
    for (let i = 0; i < 30; i++) this.body.update(0.1); // pose de orador, congelada
    this.body.root.position.y = 0.5;

    const pedestal = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.5, 1),
      new THREE.MeshStandardMaterial({ color: 0x8f8b80, roughness: 0.95 }),
    );
    pedestal.position.y = 0.25;
    pedestal.castShadow = true;
    pedestal.receiveShadow = true;
    const group = new THREE.Group();
    group.add(pedestal, this.body.root);

    this.inscription = `A ${subject.name}, ${pick(EPITHETS)}`;
    this.entity = { id: 'statue-1', type: 'marvel', object: group, radius: 0.6, solid: true, occluders: [pedestal] };
  }

  describe(viewer: Agent): string {
    return viewer === this.subject
      ? 'Una estatua de piedra sobre un pedestal… idéntica a ti.'
      : `Una estatua de piedra sobre un pedestal, idéntica a ${this.subject.name}.`;
  }

  examine(): string {
    return `En el pedestal hay una inscripción: «${this.inscription}». Juras que hace un momento la estatua miraba hacia otro lado.`;
  }

  touch(agent: Agent): string {
    return agent === this.subject
      ? 'Tocas la estatua y, por un instante, su mano de piedra se mueve para imitar la tuya.'
      : `La piedra está tibia, como si respirara. Por un segundo, la estatua de ${this.subject.name} parece sonreírte.`;
  }

  update(dt: number): void {
    // Gira despacio hacia el personaje más cercano.
    const here = this.entity.object.position;
    let nearest: Agent | null = null;
    for (const c of this.host.characters()) {
      if (!nearest || c.distanceTo(here) < nearest.distanceTo(here)) nearest = c;
    }
    if (!nearest || nearest.distanceTo(here) > 15) return;
    const desired = Math.atan2(nearest.position.x - here.x, nearest.position.z - here.z);
    let diff = (desired - this.body.root.rotation.y) % (Math.PI * 2);
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    this.body.root.rotation.y += Math.sign(diff) * Math.min(Math.abs(diff), 0.35 * dt);
  }

  dispose(): void {
    this.body.dispose();
  }
}

const RAIN_DROPS = 60;
const CURSE_SECONDS = 45;

/** Una nube diminuta que llueve sobre un solo sitio; si la tocas, te persigue lloviéndote encima. */
class TinyRainCloud implements Marvel {
  readonly entity: Entity;
  private readonly puff = new THREE.Group();
  private readonly patch: THREE.Mesh;
  private readonly rainGeo = new THREE.BufferGeometry();
  private readonly drops: { x: number; y: number; z: number }[] = [];
  private target: Agent | null = null;
  private drift: THREE.Vector3 | null = null;
  private curseLeft = 0;
  private contagionTimer = 0;
  private time = Math.random() * 10;

  constructor(
    private readonly host: MarvelHost,
    private readonly world: World,
  ) {
    const fluff = new THREE.MeshStandardMaterial({ color: 0xf4f7fb, roughness: 1, emissive: 0x334455, emissiveIntensity: 0.15 });
    const sphere = new THREE.SphereGeometry(1, 14, 10);
    for (const [x, y, z, s] of [
      [0, 0, 0, 0.45],
      [0.38, -0.05, 0.1, 0.33],
      [-0.4, -0.04, -0.05, 0.35],
      [0.1, 0.18, -0.2, 0.3],
      [-0.12, 0.1, 0.25, 0.28],
    ]) {
      const m = new THREE.Mesh(sphere, fluff);
      m.position.set(x, y, z);
      m.scale.set(s, s * 0.75, s);
      m.castShadow = true;
      this.puff.add(m);
    }
    this.puff.position.y = 2.4;

    for (let i = 0; i < RAIN_DROPS; i++) this.drops.push(this.newDrop(Math.random() * 2.2));
    this.rainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_DROPS * 6), 3));
    const rain = new THREE.LineSegments(
      this.rainGeo,
      new THREE.LineBasicMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.75 }),
    );
    rain.frustumCulled = false;

    this.patch = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 24),
      new THREE.MeshStandardMaterial({ color: 0x4d7536, roughness: 0.35 }),
    );
    this.patch.rotation.x = -Math.PI / 2;
    this.patch.position.y = 0.02;
    this.patch.receiveShadow = true;

    const group = new THREE.Group();
    group.add(this.puff, rain, this.patch);
    this.entity = { id: 'cloud-1', type: 'marvel', object: group, radius: 0.5, solid: false, occluders: [] };
  }

  describe(viewer: Agent): string {
    if (this.target === viewer) return 'La nube diminuta flota justo encima de tu cabeza y llueve solo sobre ti.';
    if (this.target) return `Una nube diminuta persigue a ${this.target.name} y le llueve encima.`;
    return 'Una nube diminuta, del tamaño de una oveja, flotando a poca altura y lloviendo sobre un único trozo de hierba.';
  }

  examine(): string {
    return 'Es una nube de verdad, fría y húmeda. Cuando te acercas, se inclina hacia ti como un perro curioso.';
  }

  touch(agent: Agent): string {
    if (this.target === agent) return 'La nube ya está encima de ti, empapándote.';
    const previous = this.target;
    this.attach(agent);
    if (previous) this.host.tell(previous.id, `La nube te abandona y se va encima de ${agent.name}.`, false);
    for (const w of witnesses(this.host, agent.position, agent)) {
      this.host.tell(w.id, `¡A ${agent.name} se le ha pegado una nube diminuta que le llueve encima!`, true);
    }
    return 'Saltas y tocas la nube… ¡y se te pega encima! Ahora llueve SOLO sobre ti. Estás empapado (aunque ya no tienes sed).';
  }

  update(dt: number): void {
    this.time += dt;
    const group = this.entity.object;
    const target = this.target;

    if (target) {
      const k = 1 - Math.exp(-6 * dt);
      group.position.x += (target.position.x - group.position.x) * k;
      group.position.z += (target.position.z - group.position.z) * k;
      this.puff.position.y += (3.3 + target.body.hoverHeight - this.puff.position.y) * k;
      target.thirst = 0;
      this.curseLeft -= dt;
      this.checkContagion(dt, target);
      if (this.target === target && this.curseLeft <= 0) this.release(target);
    } else if (this.drift) {
      const step = Math.min(1.5 * dt, group.position.distanceTo(this.drift));
      const dir = this.drift.clone().sub(group.position).setY(0).normalize();
      group.position.addScaledVector(dir, step);
      this.puff.position.y += (2.4 - this.puff.position.y) * (1 - Math.exp(-2 * dt));
      if (group.position.distanceTo(this.drift) < 0.05) {
        this.drift = null;
        this.patch.visible = true;
      }
    } else {
      this.puff.position.y = 2.4 + Math.sin(this.time) * 0.08;
    }
    this.puff.rotation.y += dt * 0.2;
    this.updateRain(dt);
  }

  private attach(agent: Agent): void {
    this.target = agent;
    this.curseLeft = CURSE_SECONDS;
    this.drift = null;
    this.patch.visible = false;
  }

  /** Si alguien se acerca mucho a la víctima, la nube puede saltar a él. */
  private checkContagion(dt: number, target: Agent): void {
    this.contagionTimer += dt;
    if (this.contagionTimer < 1) return;
    this.contagionTimer = 0;
    for (const other of this.host.characters()) {
      if (other === target || other.distanceTo(target.position) > 1.8 || Math.random() > 0.4) continue;
      this.attach(other);
      this.host.tell(other.id, `¡La nubecita salta de ${target.name} a ti! Ahora te llueve encima.`, true);
      this.host.tell(target.id, `La nube te abandona y salta encima de ${other.name}.`, false);
      return;
    }
  }

  private release(target: Agent): void {
    this.target = null;
    this.drift = this.world.freeSpot(0.8, 0.5, 4);
    this.host.tell(target.id, 'La nube se aburre de ti y se aleja flotando.', false);
  }

  private newDrop(y: number) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 0.55;
    return { x: Math.cos(a) * r, y, z: Math.sin(a) * r };
  }

  private updateRain(dt: number): void {
    const top = this.puff.position.y - 0.25;
    const pos = this.rainGeo.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    this.drops.forEach((d, i) => {
      d.y -= 7 * dt;
      if (d.y < 0) Object.assign(d, this.newDrop(top));
      arr.set([d.x, d.y, d.z, d.x, Math.min(top, d.y + 0.25), d.z], i * 6);
    });
    pos.needsUpdate = true;
  }
}

/** Los objetos imposibles del claro: los crea, los anima y responde a examine/touch. */
export class MarvelSystem implements MarvelApi {
  private readonly marvels = new Map<string, Marvel>();
  /** Objetos creados por deseos: no se ocultan con el botón de objetos raros. */
  private readonly wishes = new Map<string, Marvel>();
  private world: World | null = null;

  constructor(private readonly host: MarvelHost) {}

  spawn(world: World, characters: Agent[]): void {
    this.removeAll(world);
    this.world = world;
    const list: Marvel[] = [new WhisperingOrb(this.host), new DoorToNowhere(this.host, world), new TinyRainCloud(this.host, world)];
    if (characters.length) list.push(new UncannyStatue(this.host, pick(characters)));
    for (const m of list) {
      // Ni pegados al inicio ni en la otra punta: que los encuentren pronto.
      const spot = world.freeSpot(Math.max(m.entity.radius, 0.6), 1.2, 6, 15);
      if (!spot) continue;
      m.entity.object.position.copy(spot);
      world.add(m.entity);
      this.marvels.set(m.entity.id, m);
    }
  }

  get active(): boolean {
    return this.marvels.size > 0;
  }

  ids(): string[] {
    return [...this.marvels.keys()];
  }

  /** Libera lo propio de cada objeto (también los deseos); las entidades las quita el mundo al regenerarse. */
  clear(): void {
    for (const m of [...this.marvels.values(), ...this.wishes.values()]) m.dispose?.();
    this.marvels.clear();
    this.wishes.clear();
  }

  /** Quita del mundo los objetos imposibles fijos en plena partida (los deseos se quedan). */
  removeAll(world: World): void {
    for (const m of this.marvels.values()) {
      world.remove(m.entity.id);
      m.dispose?.();
    }
    this.marvels.clear();
  }

  addWish(world: World, marvel: Marvel): void {
    this.world = world;
    world.add(marvel.entity);
    this.wishes.set(marvel.entity.id, marvel);
  }

  removeWish(id: string): void {
    const m = this.wishes.get(id);
    if (!m) return;
    this.world?.remove(id);
    m.dispose?.();
    this.wishes.delete(id);
  }

  wishIds(): string[] {
    return [...this.wishes.keys()];
  }

  update(dt: number): void {
    for (const m of this.marvels.values()) m.update(dt);
    for (const m of this.wishes.values()) m.update(dt);
  }

  describe(viewer: Agent, id: string): string | undefined {
    return this.find(id)?.describe(viewer);
  }

  examine(viewer: Agent, id: string): string | undefined {
    return this.find(id)?.examine(viewer);
  }

  touch(agent: Agent, id: string): string | undefined {
    const m = this.find(id);
    if (!m) return undefined;
    const result = m.touch(agent);
    if (m.consumed) this.removeWish(id);
    return result;
  }

  private find(id: string): Marvel | undefined {
    return this.marvels.get(id) ?? this.wishes.get(id);
  }
}
