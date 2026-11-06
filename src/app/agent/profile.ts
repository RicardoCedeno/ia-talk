export interface CharacterProfile {
  name: string;
  color: string;
  personality: string;
  preferences: string;
}

export type StartingRelation = 'amigos' | 'desconocidos' | 'rivales' | 'peleados';

export const STARTING_RELATIONS: {
  value: StartingRelation;
  label: string;
  affinity: number;
  /** Historia compartida que recibe cada personaje; {other} es el nombre del otro. */
  backstory: string;
}[] = [
  {
    value: 'amigos',
    label: 'Amigos',
    affinity: 50,
    backstory: '{other} y tú sois amigos desde hace tiempo y os tenéis cariño.',
  },
  {
    value: 'desconocidos',
    label: 'Desconocidos',
    affinity: 0,
    backstory: 'No conoces a {other}: es la primera vez que os veis.',
  },
  {
    value: 'rivales',
    label: 'Rivales (tensos)',
    affinity: -25,
    backstory:
      '{other} y tú sois rivales: competís por las manzanas y el cofre, desconfiáis el uno del otro ' +
      'y os habéis picado más de una vez.',
  },
  {
    value: 'peleados',
    label: 'Peleados',
    affinity: -60,
    backstory:
      'Estás peleado con {other} por una discusión reciente sobre quién se quedaba las manzanas del cofre. ' +
      'Sigues dolido y no piensas dar tu brazo a torcer fácilmente.',
  },
];

export interface SimulationSetup {
  characters: CharacterProfile[];
  relation: StartingRelation;
  /** Recordar lo vivido en partidas anteriores (por nombre). Por defecto, sí. */
  keepMemories?: boolean;
  /** Poner objetos imposibles en el claro. Por defecto, no. */
  marvels?: boolean;
  /** Decir "Deseo un/una…" hace aparecer lo deseado (generado con la API). Por defecto, sí. */
  wishes?: boolean;
}

export const NAME_MAX = 16;
export const PERSONALITY_MAX = 400;
export const PREFERENCES_MAX = 300;

export const PRESETS: CharacterProfile[] = [
  {
    name: 'Pip',
    color: '#f28c38',
    personality:
      'Curioso, optimista y algo dramático. Habla mucho, hace preguntas sin parar y exagera todo lo que le pasa.',
    preferences:
      'Le encantan las manzanas y tener el cofre lleno. Le gusta hacer amigos. Odia que le ignoren.',
  },
  {
    name: 'Luna',
    color: '#8e6cf0',
    personality:
      'Sarcástica, orgullosa y muy competitiva. Se ofende con facilidad y le cuesta pedir perdón, aunque en el fondo es leal.',
    preferences:
      'Cree que todas las manzanas del claro son suyas. Le gusta la tranquilidad junto al estanque. No soporta a los charlatanes.',
  },
  {
    name: 'Bruno',
    color: '#4f9d5d',
    personality: 'Gruñón y desconfiado, de pocas palabras. Siempre se queja, pero cumple lo que promete.',
    preferences: 'Le gusta el orden y que nadie toque el cofre sin permiso. Odia el ruido y las bromas.',
  },
  {
    name: 'Mia',
    color: '#e0567a',
    personality:
      'Amable, paciente y conciliadora. Intenta calmar las discusiones y siempre busca el lado bueno de las cosas.',
    preferences: 'Le gusta compartir comida y charlar junto al estanque. Le entristecen las peleas.',
  },
];

export const DEFAULT_SETUP: SimulationSetup = {
  characters: [PRESETS[0], PRESETS[1]],
  relation: 'desconocidos',
  keepMemories: true,
  marvels: false,
  wishes: true,
};

const STORAGE_KEY = 'pip-setup-v1';

export function loadSetup(): SimulationSetup {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_SETUP);
    const parsed = JSON.parse(raw) as SimulationSetup;
    const valid =
      Array.isArray(parsed.characters) &&
      parsed.characters.length === 2 &&
      parsed.characters.every((c) => typeof c.name === 'string' && typeof c.color === 'string') &&
      STARTING_RELATIONS.some((r) => r.value === parsed.relation);
    return valid ? parsed : structuredClone(DEFAULT_SETUP);
  } catch {
    return structuredClone(DEFAULT_SETUP);
  }
}

export function saveSetup(setup: SimulationSetup): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(setup));
  } catch {
    // almacenamiento no disponible: no pasa nada
  }
}

/** Id corto y sin acentos a partir del nombre (p. ej. "Lúna" → "luna"). */
export function slugify(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'personaje';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
  return id;
}
