import { Injectable } from '@angular/core';
import { OPENAI_API_KEY } from '../../environments/environment.local';

const API_URL = 'https://api.openai.com/v1/chat/completions';

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
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: 'auto' | 'required' | 'none';
  parallel_tool_calls?: boolean;
  temperature?: number;
  max_completion_tokens?: number;
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
  usage?: { prompt_tokens: number; completion_tokens: number };
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

/**
 * Cliente mínimo de Chat Completions. La key vive en el frontend porque es un
 * proyecto personal de pruebas; en producción iría detrás de un backend.
 */
@Injectable({ providedIn: 'root' })
export class OpenAiService {
  readonly hasKey = OPENAI_API_KEY.startsWith('sk-') && OPENAI_API_KEY.length > 10;

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      let message = res.statusText || `HTTP ${res.status}`;
      let code: string | undefined;
      try {
        const body = (await res.json()) as { error?: { message?: string; code?: string } };
        message = body.error?.message ?? message;
        code = body.error?.code;
      } catch {
        // respuesta sin JSON
      }
      throw new OpenAiError(res.status, message, code);
    }
    return (await res.json()) as ChatResponse;
  }
}
