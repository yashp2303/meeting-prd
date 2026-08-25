import { getConfig, type Config } from '../config.js';
import { log, redact } from '../logger.js';

const GROQ_BASE = 'https://api.groq.com/openai/v1';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** A JSON Schema. Falls back to plain json_object mode if the model rejects it. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

interface GroqChoice {
  message?: { content?: string };
  finish_reason?: string;
}

interface GroqResponse {
  choices?: GroqChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: { message?: string };
}

export interface CompletionResult {
  text: string;
  model: string;
  finishReason: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function post(body: Record<string, unknown>, cfg: Config): Promise<Response> {
  return fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.groqApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

export async function complete(
  opts: CompletionOptions,
  cfg: Config = getConfig(),
): Promise<CompletionResult> {
  if (!cfg.groqApiKey) throw new Error('GROQ_API_KEY is not set');

  const model = opts.model ?? cfg.groqModel;
  const base: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    max_completion_tokens: opts.maxTokens ?? 16000,
  };

  // Prefer strict schema enforcement; degrade to json_object, then to plain text.
  const attempts: Record<string, unknown>[] = [];
  if (opts.jsonSchema) {
    attempts.push({
      ...base,
      response_format: {
        type: 'json_schema',
        json_schema: { name: opts.jsonSchema.name, schema: opts.jsonSchema.schema, strict: true },
      },
    });
    attempts.push({ ...base, response_format: { type: 'json_object' } });
  }
  attempts.push(base);

  let lastError = '';
  for (const [i, body] of attempts.entries()) {
    const res = await post(body, cfg);

    if (res.ok) {
      const json = (await res.json()) as GroqResponse;
      const text = json.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) {
        lastError = 'Groq returned an empty completion';
        continue;
      }
      if (i > 0) log.warn(`groq: fell back to attempt #${i + 1} for model ${model}`);
      return {
        text,
        model,
        finishReason: json.choices?.[0]?.finish_reason ?? 'stop',
        usage: json.usage,
      };
    }

    const errText = await res.text();
    lastError = `${res.status} ${redact(errText).slice(0, 400)}`;

    // 400 usually means "this model does not support that response_format" —
    // worth retrying with a looser mode. Anything else is terminal.
    if (res.status !== 400) break;
    log.debug(`groq: attempt ${i + 1} rejected, trying looser response_format`, lastError);
  }

  throw new Error(`Groq completion failed: ${lastError}`);
}

/** Models change on Groq; `meeting-prd models` reads the live list. */
export async function listModels(cfg: Config = getConfig()): Promise<string[]> {
  const res = await fetch(`${GROQ_BASE}/models`, {
    headers: { Authorization: `Bearer ${cfg.groqApiKey}` },
  });
  if (!res.ok) throw new Error(`Groq model list failed (${res.status})`);
  const json = (await res.json()) as { data?: { id: string }[] };
  return (json.data ?? []).map((m) => m.id).sort();
}

/**
 * Models sometimes wrap JSON in prose or a fenced block even in JSON mode.
 * Recover the outermost object rather than failing the whole pipeline.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }

  throw new Error(`Could not parse JSON from model output (${trimmed.length} chars)`);
}
