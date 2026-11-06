import { isRepeated } from './social';

export interface MemoryItem {
  /** Id del personaje del que trata, o "yo" / "mundo". */
  about: string;
  text: string;
  /** 1 (anécdota) a 5 (muy importante). */
  importance: number;
  /** Partida en la que se formó; distinta de la actual = "de otra vez". */
  session: number;
}

/** Detalles inventados a partir de la personalidad, para dar temas y voz propia. */
export interface CharacterCard {
  /** Personalidad + gustos de los que salió; si cambian, se regenera. */
  source: string;
  interests: string[];
  quirks: string[];
  speech: string;
  backstory: string;
  secret: string;
}

interface StoredMemory {
  items: MemoryItem[];
  opinions: Record<string, string>;
  topics: Record<string, number>;
  card: CharacterCard | null;
}

const PREFIX = 'pip-memory-v1:';
const MAX_ITEMS = 30;

/**
 * Memoria a largo plazo de un personaje: recuerdos, opinión de los demás y temas ya
 * hablados. Se guarda en localStorage por id para recordar entre partidas.
 */
export class LongTermMemory {
  items: MemoryItem[] = [];
  readonly opinions = new Map<string, string>();
  readonly topics = new Map<string, number>();
  nextTopics: string[] = [];
  card: CharacterCard | null = null;
  readonly session = Date.now();

  private constructor(
    private readonly id: string,
    private readonly persist: boolean,
  ) {}

  static load(id: string, persist: boolean): LongTermMemory {
    const memory = new LongTermMemory(id, persist);
    if (!persist) return memory;
    try {
      const raw = localStorage.getItem(PREFIX + id);
      if (!raw) return memory;
      const data = JSON.parse(raw) as StoredMemory;
      memory.items = Array.isArray(data.items) ? data.items : [];
      for (const [k, v] of Object.entries(data.opinions ?? {})) memory.opinions.set(k, v);
      // Los temas de otras partidas pesan la mitad: ya no son tan recientes.
      for (const [k, v] of Object.entries(data.topics ?? {})) {
        if (Math.floor(v / 2) > 0) memory.topics.set(k, Math.floor(v / 2));
      }
      memory.card = data.card ?? null;
    } catch {
      // memoria corrupta o sin acceso: se empieza de cero
    }
    return memory;
  }

  /** Cuántos recuerdos guardados tiene un personaje (para la pantalla inicial). */
  static storedCount(id: string): number {
    try {
      const raw = localStorage.getItem(PREFIX + id);
      return raw ? ((JSON.parse(raw) as StoredMemory).items?.length ?? 0) : 0;
    } catch {
      return 0;
    }
  }

  static clearAll(): void {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(PREFIX))
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      // sin acceso al almacenamiento
    }
  }

  get previousCount(): number {
    return this.items.filter((i) => i.session !== this.session).length;
  }

  /** Añade un recuerdo si no está repetido. Devuelve si se añadió. */
  add(about: string, text: string, importance: number): boolean {
    const clean = text.trim().slice(0, 200);
    if (!clean || isRepeated(clean, this.items.map((i) => i.text))) return false;
    const level = Math.min(5, Math.max(1, Math.round(importance) || 1));
    this.items.push({ about, text: clean, importance: level, session: this.session });
    this.prune();
    return true;
  }

  noteTopics(topics: string[]): void {
    for (const t of topics) {
      const key = t.trim().toLowerCase().slice(0, 30);
      if (key) this.topics.set(key, (this.topics.get(key) ?? 0) + 1);
    }
  }

  save(): void {
    if (!this.persist) return;
    const data: StoredMemory = {
      items: this.items,
      opinions: Object.fromEntries(this.opinions),
      topics: Object.fromEntries(this.topics),
      card: this.card,
    };
    try {
      localStorage.setItem(PREFIX + this.id, JSON.stringify(data));
    } catch {
      // almacenamiento lleno o bloqueado: la memoria sigue en esta partida
    }
  }

  /** Se queda con los más importantes, favoreciendo los de esta partida y los recientes. */
  private prune(): void {
    if (this.items.length <= MAX_ITEMS) return;
    const n = this.items.length;
    const score = (item: MemoryItem, index: number) =>
      item.importance + (item.session === this.session ? 1.5 : 0) + index / n;
    const keep = new Set(
      this.items
        .map((item, index) => ({ item, s: score(item, index) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, MAX_ITEMS)
        .map((x) => x.item),
    );
    this.items = this.items.filter((i) => keep.has(i));
  }
}
