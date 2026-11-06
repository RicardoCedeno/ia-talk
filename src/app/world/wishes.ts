import * as THREE from 'three';
import type { Agent } from '../agent/agent';
import { OpenAiService } from '../core/openai.service';
import { Entity } from './entities';
import { Marvel, MarvelSystem } from './marvels';
import { World } from './world';

/** Segundos mínimos entre dos deseos del mismo personaje. */
export const WISH_COOLDOWN = 45;
/** Máximo de objetos deseados a la vez; el más antiguo se desvanece. */
const MAX_WISHES = 5;
/** Probabilidad de que el deseo se cumpla "con un giro", como un genio travieso. */
const TWIST_CHANCE = 0.25;
const MAX_SIZE = 2.5;

const SHAPES = ['caja', 'esfera', 'cilindro', 'cono', 'toro', 'capsula'] as const;
type Shape = (typeof SHAPES)[number];
const EFFECTS = ['ninguno', 'sacia_hambre', 'sacia_sed', 'levitar'] as const;
type Effect = (typeof EFFECTS)[number];

interface Part {
  forma: Shape;
  color: string;
  tamano: number[];
  posicion: number[];
  rotacion: number[];
  brilla: boolean;
}

interface Design {
  nombre: string;
  descripcion_visible: string;
  detalle_al_examinar: string;
  efecto_al_tocar: string;
  efecto_mecanico: Effect;
  piezas: Part[];
}

/** Lo que el sistema de deseos necesita de la simulación. */
export interface WishHost {
  time(): number;
  log(agent: Agent, text: string): void;
  /** Cuenta un suceso a un personaje concreto. */
  tell(agent: Agent, text: string): void;
  /** Cuenta un suceso a quien esté mirando a `agent`. */
  announce(agent: Agent, text: string): void;
  usage(input: number, output: number): void;
}

// Geometrías unitarias (≈1 m) que se escalan con el "tamano" de cada pieza.
const UNIT: Record<Shape, THREE.BufferGeometry> = {
  caja: new THREE.BoxGeometry(1, 1, 1),
  esfera: new THREE.SphereGeometry(0.5, 16, 12),
  cilindro: new THREE.CylinderGeometry(0.5, 0.5, 1, 16),
  cono: new THREE.ConeGeometry(0.5, 1, 16),
  toro: new THREE.TorusGeometry(0.4, 0.1, 8, 24),
  // Diámetro 1 y alto 2: al escalar se divide el alto entre 2 (ver buildModel).
  capsula: new THREE.CapsuleGeometry(0.5, 1, 4, 12),
};

const vec3 = (v: number[], fallback: number) =>
  new THREE.Vector3(...[0, 1, 2].map((i) => (Number.isFinite(v[i]) ? v[i] : fallback)));

/** Construye el objeto con las piezas, lo escala a un tamaño razonable y lo apoya en el suelo. */
function buildModel(parts: Part[]): { group: THREE.Group; materials: THREE.Material[]; size: THREE.Vector3 } {
  const model = new THREE.Group();
  const materials: THREE.Material[] = [];
  for (const p of parts.slice(0, 14)) {
    const geometry = UNIT[p.forma] ?? UNIT.caja;
    let color: THREE.Color;
    try {
      color = new THREE.Color(p.color);
    } catch {
      color = new THREE.Color('#cccccc');
    }
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.6,
      flatShading: true,
      emissive: p.brilla ? color : new THREE.Color(0x000000),
      emissiveIntensity: p.brilla ? 0.6 : 0,
    });
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    const size = vec3(p.tamano, 0.3);
    if (p.forma === 'capsula') size.y /= 2;
    mesh.scale.set(Math.max(0.02, size.x), Math.max(0.02, size.y), Math.max(0.02, size.z));
    mesh.position.copy(vec3(p.posicion, 0));
    const rot = vec3(p.rotacion, 0).multiplyScalar(THREE.MathUtils.DEG2RAD);
    mesh.rotation.set(rot.x, rot.y, rot.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    model.add(mesh);
  }

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = Math.min(1, MAX_SIZE / Math.max(size.x, size.y, size.z, 0.01));
  model.scale.setScalar(scale);
  box.setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.set(-center.x, -box.min.y, -center.z); // centrado y apoyado en el suelo
  return { group: model, materials, size: box.getSize(new THREE.Vector3()) };
}

/** Un objeto aparecido por un deseo. Se comporta como un objeto imposible más. */
class WishedObject implements Marvel {
  readonly entity: Entity;
  consumed = false;
  private readonly model: THREE.Group;
  private readonly flash: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly materials: THREE.Material[];
  private age = 0;

  constructor(
    id: string,
    private readonly design: Design,
    private readonly wisher: Agent,
  ) {
    const built = buildModel(design.piezas);
    this.model = built.group;
    this.materials = built.materials;
    const holder = new THREE.Group();
    holder.add(this.model);
    holder.scale.setScalar(0.01);

    // Destello al aparecer.
    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff3b0, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.flash.position.y = Math.max(0.4, built.size.y / 2);

    const group = new THREE.Group();
    group.add(holder, this.flash);
    const radius = THREE.MathUtils.clamp(Math.max(built.size.x, built.size.z) / 2, 0.25, 1.25);
    // Los objetos grandes estorban el paso; los pequeños, no.
    const solid = radius > 0.5 && built.size.y > 0.8;
    this.entity = { id, type: 'marvel', object: group, radius, solid, occluders: [] };
  }

  describe(): string {
    return `${this.design.nombre}: ${this.design.descripcion_visible} (apareció por un deseo de ${this.wisher.name}).`;
  }

  examine(): string {
    return this.design.detalle_al_examinar;
  }

  touch(agent: Agent): string {
    const extra = this.applyEffect(agent);
    return `${this.design.efecto_al_tocar}${extra}`;
  }

  update(dt: number): void {
    this.age += dt;
    const holder = this.model.parent!;
    // Aparece creciendo con un pequeño rebote.
    const t = Math.min(1, this.age / 0.8);
    const bounce = t < 1 ? 1 + Math.sin(t * Math.PI) * 0.25 : 1;
    holder.scale.setScalar(Math.max(0.01, t * bounce));
    const f = Math.min(1, this.age / 0.7);
    this.flash.visible = f < 1;
    this.flash.scale.setScalar(0.5 + f * 3);
    this.flash.material.opacity = 0.9 * (1 - f);
  }

  dispose(): void {
    this.materials.forEach((m) => m.dispose());
    this.flash.geometry.dispose();
    this.flash.material.dispose();
  }

  private applyEffect(agent: Agent): string {
    switch (this.design.efecto_mecanico) {
      case 'sacia_hambre':
        agent.hunger = Math.max(0, agent.hunger - 40);
        this.consumed = true;
        return ` Te lo comes y se te quita el hambre (hambre: ${Math.round(agent.hunger)}).`;
      case 'sacia_sed':
        agent.thirst = Math.max(0, agent.thirst - 50);
        this.consumed = true;
        return ` Te lo bebes y se te quita la sed (sed: ${Math.round(agent.thirst)}).`;
      case 'levitar':
        if (agent.powers.has('levitar')) return '';
        agent.powers.add('levitar');
        return ' ¡Te sientes ligero! Ahora puedes levitar (levitate) y bajar (land) cuando quieras.';
      default:
        return '';
    }
  }
}

const str = { type: 'string' };
const numbers = { type: 'array', items: { type: 'number' } };
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const DESIGN_SCHEMA = object({
  nombre: str,
  descripcion_visible: str,
  detalle_al_examinar: str,
  efecto_al_tocar: str,
  efecto_mecanico: { type: 'string', enum: [...EFFECTS] },
  piezas: {
    type: 'array',
    items: object({
      forma: { type: 'string', enum: [...SHAPES] },
      color: str,
      tamano: numbers,
      posicion: numbers,
      rotacion: numbers,
      brilla: { type: 'boolean' },
    }),
  },
});

/** Pide al modelo que diseñe el objeto deseado con piezas primitivas. */
async function designObject(openai: OpenAiService, wisher: Agent, wish: string, twist: boolean, host: WishHost) {
  const res = await openai.chat({
    temperature: 0.8,
    // Diseñar en 3D sin ver el resultado sale mejor si piensa un poco antes.
    reasoning_effort: 'low',
    max_completion_tokens: 1500,
    messages: [
      {
        role: 'system',
        content: `Diseñas objetos 3D low-poly para un juego, hechos solo con piezas primitivas (${SHAPES.join(', ')}).
Reglas de las piezas:
- Unidades en metros. y = 0 es el suelo; "posicion" es el CENTRO de cada pieza [x, y, z]. El objeto se apoya en el suelo.
- "tamano" son las dimensiones de la pieza [ancho, alto, fondo]: caja = lados; esfera = diámetros; cilindro y cono =
  [diámetro, alto, diámetro]; toro = [diámetro, diámetro, grosor] (el toro está de pie en el plano XY); capsula = diámetros.
- "rotacion" en grados [x, y, z]. Entre 3 y 12 piezas. Tamaño total entre 0.3 y 2.5 m.
- Colores en hexadecimal (#rrggbb), vivos y reconocibles. "brilla": true solo para partes mágicas o luminosas.
- Que se reconozca a simple vista lo que es. Si piden un ser vivo, haz una figura quieta, como un muñeco.
Textos en español y breves: descripcion_visible (lo que se ve, 1 frase), detalle_al_examinar (1-2 frases),
efecto_al_tocar (qué pasa al tocarlo, en segunda persona, 1-2 frases, puede ser mágico o gracioso).
efecto_mecanico: sacia_hambre si es comida, sacia_sed si es bebida, levitar si sirve para volar, si no ninguno.`,
      },
      {
        role: 'user',
        content:
          `${wisher.name} ha dicho en voz alta: "Deseo ${wish}".\n` +
          (twist
            ? 'Cúmplelo con un giro inesperado, como un genio travieso: que se parezca a lo pedido pero con un detalle absurdo o inquietante.'
            : 'Cúmplelo fielmente.'),
      },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'objeto', strict: true, schema: DESIGN_SCHEMA } },
  });
  if (res.usage) host.usage(res.usage.prompt_tokens, res.usage.completion_tokens);
  const design = JSON.parse(res.choices[0]?.message.content ?? '{}') as Partial<Design>;
  if (!design.piezas?.length) throw new Error('diseño vacío');
  // Sin esquema estricto (p. ej. DeepSeek) podría faltar algún texto.
  return {
    nombre: design.nombre || wish,
    descripcion_visible: design.descripcion_visible ?? '',
    detalle_al_examinar: design.detalle_al_examinar ?? 'No ves nada más de especial.',
    efecto_al_tocar: design.efecto_al_tocar ?? 'Lo tocas. Es real.',
    efecto_mecanico: EFFECTS.includes(design.efecto_mecanico as Effect) ? (design.efecto_mecanico as Effect) : 'ninguno',
    piezas: design.piezas.filter((p) => SHAPES.includes(p.forma)),
  };
}

/** Detecta deseos en lo que dicen los personajes y hace aparecer lo deseado. */
export class WishSystem {
  private readonly lastWish = new Map<string, number>();
  private readonly pending = new Set<string>();
  private counter = 0;

  constructor(
    private readonly openai: OpenAiService,
    private readonly marvels: MarvelSystem,
    private readonly host: WishHost,
  ) {}

  /** "Deseo una espada de fuego" → "una espada de fuego". Exige artículo para no confundirlo con "deseo saber…". */
  static detect(text: string): string | null {
    const m = text.match(
      /\bdeseo\s+(?:que\s+aparezca\s+|tener\s+|ver\s+)?((?:un|una|unos|unas|el|la|los|las|mi|mis)\s+[^.!?¡¿;]{2,60})/i,
    );
    return m ? m[1].trim().replace(/[,\s]+$/, '') : null;
  }

  reset(): void {
    this.lastWish.clear();
    this.pending.clear();
  }

  /** Procesa un deseo. Devuelve false si no se admite ahora (enfriamiento o ya pidiendo otro). */
  request(wisher: Agent, wish: string, world: World): boolean {
    const now = this.host.time();
    const last = this.lastWish.get(wisher.id) ?? -Infinity;
    if (this.pending.has(wisher.id) || now - last < WISH_COOLDOWN) return false;
    this.pending.add(wisher.id);
    this.lastWish.set(wisher.id, now);
    this.host.log(wisher, `✨ Ha pedido un deseo: ${wish}…`);
    void this.grant(wisher, wish, world);
    return true;
  }

  private async grant(wisher: Agent, wish: string, world: World): Promise<void> {
    try {
      const twist = Math.random() < TWIST_CHANCE;
      const design = await designObject(this.openai, wisher, wish, twist, this.host);
      const id = `wish-${++this.counter}`;
      const obj = new WishedObject(id, design, wisher);
      const spot = this.spotNear(wisher, world, obj.entity.radius);
      obj.entity.object.position.copy(spot);
      obj.entity.object.rotation.y = Math.atan2(wisher.position.x - spot.x, wisher.position.z - spot.z);

      // Si hay demasiados, el más antiguo se desvanece.
      const existing = this.marvels.wishIds();
      if (existing.length >= MAX_WISHES) this.marvels.removeWish(existing[0]);
      this.marvels.addWish(world, obj);
      wisher.known.set(id, { id, type: 'marvel', position: spot.clone(), lastSeen: this.host.time() });

      this.host.tell(
        wisher,
        `¡Tu deseo se ha cumplido! En un destello aparece a tu lado ${design.nombre} (${id}): ${design.descripcion_visible}`,
      );
      this.host.announce(wisher, `¡En un destello aparece ${design.nombre} junto a ${wisher.name}, de la nada!`);
      this.host.log(wisher, `✨ Deseo cumplido${twist ? ' (con truco)' : ''}: ${design.nombre}.`);
    } catch (e) {
      this.host.tell(wisher, 'Pides el deseo… pero no pasa nada. Quizá no era el momento.');
      this.host.log(wisher, `El deseo no se pudo cumplir (${String(e)}).`);
    } finally {
      this.pending.delete(wisher.id);
    }
  }

  /** Un hueco libre delante del personaje (o a su alrededor). */
  private spotNear(agent: Agent, world: World, radius: number): THREE.Vector3 {
    for (const dist of [1.8, 2.4, 3.2]) {
      for (const offset of [0, 0.6, -0.6, 1.2, -1.2, 2, -2, Math.PI]) {
        const a = agent.heading + offset;
        const x = agent.position.x + Math.sin(a) * (dist + radius);
        const z = agent.position.z + Math.cos(a) * (dist + radius);
        if (world.isFree(x, z, radius)) return new THREE.Vector3(x, 0, z);
      }
    }
    return world.freeSpot(radius, 0.3, 0) ?? new THREE.Vector3(agent.position.x + 2, 0, agent.position.z);
  }
}
