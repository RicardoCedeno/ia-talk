import { CharacterCard } from './memory';
import { CharacterProfile } from './profile';
import { ChatRequest, OpenAiService } from '../core/openai.service';

const MODEL = 'gpt-4o-mini';

type Usage = (input: number, output: number) => void;

const str = { type: 'string' };
const strList = { type: 'array', items: str };

function object(properties: Record<string, unknown>) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

async function askJson<T>(openai: OpenAiService, request: Omit<ChatRequest, 'model'>, onUsage: Usage): Promise<T> {
  const res = await openai.chat({ model: MODEL, ...request });
  if (res.usage) onUsage(res.usage.prompt_tokens, res.usage.completion_tokens);
  return JSON.parse(res.choices[0]?.message.content ?? '{}') as T;
}

export const profileSource = (p: CharacterProfile) => `${p.personality.trim()}|${p.preferences.trim()}`;

/** Amplía la personalidad escrita por el usuario con intereses, manías y una pequeña historia. */
export async function generateCard(
  openai: OpenAiService,
  profile: CharacterProfile,
  onUsage: Usage,
): Promise<CharacterCard> {
  const data = await askJson<{
    intereses: string[];
    manias: string[];
    forma_de_hablar: string;
    historia: string;
    secreto: string;
  }>(
    openai,
    {
      temperature: 0.9,
      max_completion_tokens: 400,
      messages: [
        {
          role: 'system',
          content:
            'Eres guionista. Amplía la ficha de un personaje de una simulación en un claro del bosque, ' +
            'siendo fiel a su personalidad y gustos. Responde en español y con frases cortas. ' +
            'intereses: 4 o 5 temas de conversación que le apasionan (variados, NO sobre comida). ' +
            'manias: 2 o 3 manías o costumbres. forma_de_hablar: cómo habla (muletillas, registro). ' +
            'historia: 2 frases de su pasado. secreto: algo que no cuenta fácilmente.',
        },
        {
          role: 'user',
          content: `Nombre: ${profile.name}\nPersonalidad: ${profile.personality}\nGustos y preferencias: ${profile.preferences}`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'ficha',
          strict: true,
          schema: object({ intereses: strList, manias: strList, forma_de_hablar: str, historia: str, secreto: str }),
        },
      },
    },
    onUsage,
  );
  return {
    source: profileSource(profile),
    interests: data.intereses.slice(0, 5),
    quirks: data.manias.slice(0, 3),
    speech: data.forma_de_hablar,
    backstory: data.historia,
    secret: data.secreto,
  };
}

export interface Reflection {
  recuerdos: { sobre: string; texto: string; importancia: number }[];
  opiniones: { id: string; opinion: string; ajuste_afinidad: number; motivo: string }[];
  temas_hablados: string[];
  proximos_temas: string[];
}

export interface ReflectionInput {
  profile: CharacterProfile;
  memories: string;
  opinions: string;
  dialogue: string;
  events: string;
  characters: { id: string; nombre: string }[];
}

/**
 * El personaje repasa lo que ha pasado: qué merece recordar, qué opina ahora de los
 * demás (según SU personalidad y gustos) y de qué temas se ha hablado.
 */
export function reflect(openai: OpenAiService, input: ReflectionInput, onUsage: Usage): Promise<Reflection> {
  const p = input.profile;
  return askJson<Reflection>(
    openai,
    {
      temperature: 0.5,
      max_completion_tokens: 500,
      messages: [
        {
          role: 'system',
          content: `Eres la mente de ${p.name}. Personalidad: ${p.personality}. Gustos y preferencias: ${p.preferences}.
Repasa lo que acaba de pasar y actualiza tu memoria. Todo en primera persona y en español.
- recuerdos: SOLO hechos nuevos y concretos que merezca la pena recordar: lo que otros te han contado de sí mismos
  (gustos, historias, opiniones), cosas que pasaron entre vosotros, promesas, ofensas, favores, bromas. No repitas
  los que ya tienes. No guardes cosas triviales (quién comió, quién bebió, quién gritó qué) ni frases sueltas:
  solo lo que recordarías dentro de una semana. Mejor 0 o 1 recuerdos buenos que muchos flojos.
  "sobre" es el id del personaje, o "yo" o "mundo". importancia de 1 a 5 (5 = inolvidable).
- opiniones: tu opinión actual de cada personaje con el que hayas tratado, juzgada según TU personalidad y TUS gustos.
  ajuste_afinidad entre -8 y 8: negativo si lo que ha dicho o hecho choca con tus gustos o tu forma de ser,
  positivo si encaja. 0 si no ha pasado nada relevante.
- temas_hablados: los temas de la conversación reciente, 1-3 palabras cada uno.
- proximos_temas: 2 a 4 ideas concretas para tus próximas conversaciones, coherentes con tus intereses y con lo que
  sabes del otro (preguntas personales, anécdotas, planes, rencillas...). Nada sobre comida ni agua.`,
        },
        {
          role: 'user',
          content: [
            `Personajes: ${JSON.stringify(input.characters)}`,
            `Recuerdos que ya tienes:\n${input.memories || '(ninguno)'}`,
            `Tus opiniones actuales:\n${input.opinions || '(ninguna)'}`,
            `Conversación reciente:\n${input.dialogue || '(nada)'}`,
            `Sucesos recientes:\n${input.events || '(nada)'}`,
          ].join('\n\n'),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'reflexion',
          strict: true,
          schema: object({
            recuerdos: {
              type: 'array',
              items: object({ sobre: str, texto: str, importancia: { type: 'integer' } }),
            },
            opiniones: {
              type: 'array',
              items: object({ id: str, opinion: str, ajuste_afinidad: { type: 'integer' }, motivo: str }),
            },
            temas_hablados: strList,
            proximos_temas: strList,
          }),
        },
      },
    },
    onUsage,
  );
}
