import { Injectable, signal } from '@angular/core';
import {
  DEEPSEEK_API_KEY,
  GEMINI_API_KEY,
  LLM_MAX_REQUESTS_PER_MINUTE,
  LLM_PROVIDER,
  OPENAI_API_KEY,
} from '../../environments/environment.local';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    strict?: boolean;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: 'auto' | 'required' | 'none';
  parallel_tool_calls?: boolean;
  temperature?: number;
  max_completion_tokens?: number;
  /** Cuánto "piensa" antes de responder (solo modelos con razonamiento; 'none' = nada). */
  reasoning_effort?: 'none' | 'low' | 'medium';
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatResponse {
  choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    /** DeepSeek: tokens de entrada servidos desde caché. */
    prompt_cache_hit_tokens?: number;
    /** OpenAI: ídem. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export class OpenAiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** USD por millón de tokens. `cachedInput`: entrada que el proveedor ya tenía en caché. */
interface Price {
  input: number;
  cachedInput: number;
  output: number;
}

interface Provider {
  url: string;
  model: string;
  key: string;
  /** Si el modelo razona antes de responder (y acepta reasoning_effort). */
  thinking: boolean;
  /** Si acepta response_format json_schema; si no, se pide JSON "a secas" con el esquema en el prompt. */
  jsonSchema: boolean;
  /** Nombre del campo del límite de salida. */
  maxTokensField: 'max_completion_tokens' | 'max_tokens';
  /** Tarifa (puede depender de la hora), o null si no se conoce. */
  price: ((now: Date) => Price) | null;
}

/** DeepSeek cobra la mitad fuera de su hora punta (lun–vie 01–04 y 06–10 UTC). */
function deepseekFlashPrice(now: Date): Price {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const peak = day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  const k = peak ? 2 : 1;
  return { input: 0.15 * k, cachedInput: 0.003 * k, output: 0.6 * k };
}

const PROVIDERS: Record<typeof LLM_PROVIDER, Provider> = {
  // DeepSeek y Gemini exponen APIs compatibles con la de OpenAI.
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-flash',
    key: DEEPSEEK_API_KEY,
    thinking: true,
    jsonSchema: false,
    maxTokensField: 'max_tokens',
    price: deepseekFlashPrice,
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-3.5-flash',
    key: GEMINI_API_KEY,
    thinking: true,
    jsonSchema: true,
    maxTokensField: 'max_completion_tokens',
    price: null, // pon aquí la tarifa de tu cuenta para ver el coste estimado
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    key: OPENAI_API_KEY,
    thinking: false,
    jsonSchema: true,
    maxTokensField: 'max_completion_tokens',
    price: () => ({ input: 0.15, cachedInput: 0.075, output: 0.6 }),
  },
};

/** Tokens extra para el razonamiento oculto, que cuenta dentro del límite de salida (DeepSeek piensa mucho). */
const THINKING_BUDGET = 4096;
const RETRY_STATUS = new Set([429, 500, 503]);
const MAX_ATTEMPTS = 3;
/** Como mucho se espera esto (s) a que la API deje volver a llamar. */
const MAX_RETRY_WAIT = 65;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** "Please retry in 22.45s" / "in 592ms" → segundos. */
function retryDelay(message: string): number | null {
  const m = message.match(/retry in ([\d.]+)(ms|s)\b/i);
  if (!m) return null;
  return m[2].toLowerCase() === 'ms' ? Number(m[1]) / 1000 : Number(m[1]);
}

/**
 * Cliente mínimo de Chat Completions (OpenAI, o DeepSeek y Gemini por sus APIs compatibles).
 * La key vive en el frontend porque es un proyecto personal de pruebas.
 */
@Injectable({ providedIn: 'root' })
export class OpenAiService {
  private readonly provider = PROVIDERS[LLM_PROVIDER];
  readonly model = this.provider.model;
  readonly hasKey = this.provider.key.trim().length > 10;
  /** Gasto estimado en USD en esta sesión, o null si no se conoce la tarifa. */
  readonly spent = signal<number | null>(this.provider.price ? 0 : null);
  /** Momentos (ms) de las peticiones del último minuto, para no pasar del límite. */
  private readonly sent: number[] = [];

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { reasoning_effort, max_completion_tokens, ...rest } = request;
    const p = this.provider;
    const effort = p.thinking ? (reasoning_effort ?? 'none') : undefined;
    const extra = effort && effort !== 'none' ? THINKING_BUDGET : 0;
    const body: Record<string, unknown> = {
      model: p.model,
      ...rest,
      ...(max_completion_tokens && { [p.maxTokensField]: max_completion_tokens + extra }),
      ...(effort && { reasoning_effort: effort }),
    };
    if (rest.response_format && !p.jsonSchema) {
      // Sin json_schema: JSON "a secas" y el esquema explicado en un mensaje de sistema.
      body['response_format'] = { type: 'json_object' };
      body['messages'] = [
        {
          role: 'system',
          content:
            'Responde SOLO con un objeto JSON válido, sin texto antes ni después, que cumpla este JSON Schema ' +
            `(todos los campos obligatorios): ${JSON.stringify(rest.response_format.json_schema.schema)}`,
        },
        ...rest.messages,
      ];
    }

    // Los picos de demanda (503) y los límites por minuto (429) suelen ser pasajeros: reintenta.
    for (let attempt = 1; ; attempt++) {
      await this.throttle();
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = (await res.json()) as ChatResponse;
        this.track(data.usage);
        return data;
      }

      const error = await this.readError(res);
      // Agotar la cuota diaria no se arregla esperando unos segundos.
      if (res.status === 429 && /per ?day|daily/i.test(error.message)) {
        throw new OpenAiError(429, error.message, 'daily_quota');
      }
      const wait = retryDelay(error.message) ?? 1.5 * attempt;
      if (attempt >= MAX_ATTEMPTS || !RETRY_STATUS.has(res.status) || wait > MAX_RETRY_WAIT) throw error;
      await sleep(wait * 1000 + 250);
    }
  }

  /** Suma el coste de una respuesta, separando la entrada que estaba en caché (mucho más barata). */
  private track(usage: ChatResponse['usage']): void {
    const price = this.provider.price?.(new Date());
    if (!usage || !price) return;
    const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const fresh = Math.max(0, usage.prompt_tokens - cached);
    const cost = (fresh * price.input + cached * price.cachedInput + usage.completion_tokens * price.output) / 1e6;
    this.spent.update((v) => (v ?? 0) + cost);
  }

  /** Espera lo necesario para no superar LLM_MAX_REQUESTS_PER_MINUTE (compartido por todos los personajes). */
  private async throttle(): Promise<void> {
    const limit = LLM_MAX_REQUESTS_PER_MINUTE;
    if (!limit) return;
    for (;;) {
      const now = Date.now();
      while (this.sent.length && now - this.sent[0] >= 60_000) this.sent.shift();
      if (this.sent.length < limit) {
        this.sent.push(now);
        return;
      }
      await sleep(60_000 - (now - this.sent[0]) + 50);
    }
  }

  private async readError(res: Response): Promise<OpenAiError> {
    let message = res.statusText || `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      // OpenAI devuelve {error}; Gemini, a veces, [{error}].
      const raw = (await res.json()) as unknown;
      const body = (Array.isArray(raw) ? raw[0] : raw) as { error?: { message?: string; code?: string; status?: string } };
      message = body.error?.message ?? message;
      code = body.error?.code ?? body.error?.status;
    } catch {
      // respuesta sin JSON
    }
    return new OpenAiError(res.status, message, code);
  }
}
