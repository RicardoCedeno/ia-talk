// Copia este archivo como `environment.local.ts` (ignorado por git) y pon tus API keys.

/** Proveedor activo: 'deepseek', 'openai' o 'gemini'. */
export const LLM_PROVIDER: 'deepseek' | 'openai' | 'gemini' = 'deepseek';

export const DEEPSEEK_API_KEY = '';

export const OPENAI_API_KEY = '';

export const GEMINI_API_KEY = '';

/** Máximo de peticiones por minuto (0 = sin límite). El nivel gratuito de Gemini permite 5/min. */
export const LLM_MAX_REQUESTS_PER_MINUTE = 0;
