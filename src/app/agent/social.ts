import type { Agent } from './agent';
import type { Entity } from '../world/entities';

export const TONES = ['amable', 'neutral', 'molesto', 'hostil'] as const;
export type Tone = (typeof TONES)[number];

/** Distancia máxima para hablarle a alguien (m). */
export const TALK_DISTANCE = 4.5;
/** Distancia a la que se oye lo que alguien dice en voz alta (m). */
export const HEAR_DISTANCE = 8;
/** Distancia máxima a la que se oye un grito (m); cubre casi todo el claro. */
export const SHOUT_DISTANCE = 30;

/** talk: a alguien cercano; shout: a alguien lejano; say: a nadie en concreto. */
export type SpeechMode = 'talk' | 'shout' | 'say';
/** Distancia máxima para dar algo en mano (m). */
export const GIVE_DISTANCE = 2.2;
/** Con esta afinidad o menos, dos personajes están peleados. */
export const FIGHT_THRESHOLD = -40;
/** Puntos por segundo que la afinidad vuelve hacia 0 (se les pasa el enfado, o se enfría la amistad). */
export const AFFINITY_DRIFT = 0.1;

/** Cambio de afinidad de quien escucha hacia quien le habla, según el tono. */
// Moderados a propósito: la reflexión ajusta además la afinidad según la personalidad y los gustos de cada uno.
export const HEARD_DELTA: Record<Tone, number> = { amable: 3, neutral: 0, molesto: -4, hostil: -10 };
/** Cambio de afinidad de quien habla hacia quien le escucha. */
export const SPOKEN_DELTA: Record<Tone, number> = { amable: 1, neutral: 0, molesto: -2, hostil: -5 };

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Si una frase es (casi) igual a otra ya dicha: misma frase, o una contiene a la otra. */
export function isRepeated(line: string, previous: readonly string[]): string | undefined {
  const n = normalize(line);
  return previous.find((p) => {
    const q = normalize(p);
    return q === n || (Math.min(q.length, n.length) > 15 && (q.includes(n) || n.includes(q)));
  });
}
export const GIFT_DELTA = { received: 15, given: 5 };

export function toTone(value: unknown): Tone {
  return TONES.includes(value as Tone) ? (value as Tone) : 'neutral';
}

export type Relation = 'amigos' | 'se llevan bien' | 'neutral' | 'tensos' | 'peleados';

export function relationLabel(affinity: number): Relation {
  if (affinity >= 40) return 'amigos';
  if (affinity >= 10) return 'se llevan bien';
  if (affinity > -15) return 'neutral';
  if (affinity > FIGHT_THRESHOLD) return 'tensos';
  return 'peleados';
}

/** Lo que las acciones necesitan saber de los demás personajes. */
export interface SocialHub {
  agent(id: string): Agent | undefined;
  others(self: Agent): Agent[];
  /** `to` = null (modo say): lo dice en voz alta para quien esté cerca. */
  speak(from: Agent, to: Agent | null, text: string, tone: Tone, mode: SpeechMode): void;
  gift(from: Agent, to: Agent, item: Entity): void;
  /** Cuenta a quien esté mirando algo llamativo que acaba de hacer `from`. */
  announce(from: Agent, text: string): void;
}
