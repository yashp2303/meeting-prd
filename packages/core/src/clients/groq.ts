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

/** ~4 characters per token is close enough to budget against. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface TpmError {
  limit: number;
  requested: number;
}

/**
 * Groq's free tier meters tokens-per-minute against prompt + max_completion_tokens,
 * not actual usage. So reserving a large completion budget can fail a request
 * that would comfortably have fit. The 413 body carries both numbers; parsing
 * them lets us retry with a budget that actually fits instead of guessing.
 */
function parseTpmError(body: string): TpmError | null {
  const limit = body.match(/Limit\s+(\d+)/i);
  const requested = body.match(/Requested\s+(\d+)/i);
  if (!limit?.[1] || !requested?.[1]) return null;
  return { limit: Number(limit[1]), requested: Number(requested[1]) };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function complete(
  opts: CompletionOptions,
  cfg: Config = getConfig(),
): Promise<CompletionResult> {
  if (!cfg.groqApiKey) throw new Error('GROQ_API_KEY is not set');

  const model = opts.model ?? cfg.groqModel;
  const promptTokens = estimateTokens(opts.messages.map((m) => m.content).join('\n'));

  let budget = opts.maxTokens ?? cfg.groqMaxTokens;
  const base = (max: number): Record<string, unknown> => ({
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    max_completion_tokens: max,
  });

  /*
   * json_object first, deliberately.
   *
   * Constrained decoding via `json_schema` + `strict` fails on deeply nested
   * schemas — Groq returns json_validate_failed with an empty generation. Plain
   * json_object, with the schema described in the prompt, is both more reliable
   * and cheaper here. The stricter modes stay as later fallbacks in case a
   * future model handles them better.
   */
  const shapes: ((max: number) => Record<string, unknown>)[] = [];
  if (opts.jsonSchema) {
    shapes.push((max) => ({ ...base(max), response_format: { type: 'json_object' } }));
    shapes.push((max) => ({
      ...base(max),
      response_format: {
        type: 'json_schema',
        json_schema: { name: opts.jsonSchema!.name, schema: opts.jsonSchema!.schema },
      },
    }));
  }
  shapes.push(base);

  let lastError = '';
  let shapeIndex = 0;
  let tpmRetries = 0;
  let rateRetries = 0;

  while (shapeIndex < shapes.length) {
    const res = await post(shapes[shapeIndex]!(budget), cfg);

    if (res.ok) {
      const json = (await res.json()) as GroqResponse;
      const text = json.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) {
        lastError = 'Groq returned an empty completion';
        shapeIndex++;
        continue;
      }
      if (shapeIndex > 0) log.warn(`groq: used fallback response_format #${shapeIndex + 1}`);
      const finishReason = json.choices?.[0]?.finish_reason ?? 'stop';
      if (finishReason === 'length') {
        log.warn(
          `groq: output hit the ${budget}-token ceiling and was truncated — ` +
            `the PRD may be incomplete. Raise GROQ_MAX_TOKENS if your tier allows it.`,
        );
      }
      return { text, model, finishReason, usage: json.usage };
    }

    const errText = await res.text();
    lastError = `${res.status} ${redact(errText).slice(0, 400)}`;

    // 413: the reserved completion budget pushed us over the per-minute cap.
    // Refit to what the tier actually allows rather than failing outright.
    if (res.status === 413 && tpmRetries < 3) {
      const tpm = parseTpmError(errText);
      if (tpm) {
        const fitted = Math.max(1024, tpm.limit - promptTokens - 512);
        if (fitted < budget) {
          log.warn(
            `groq: tier allows ${tpm.limit} tokens/min — reducing completion budget ` +
              `${budget} -> ${fitted}`,
          );
          budget = fitted;
          tpmRetries++;
          continue;
        }
        throw new Error(
          `Groq tokens-per-minute limit is ${tpm.limit}, but this prompt alone needs ~${promptTokens}. ` +
            `Shorten the transcript or upgrade the Groq tier.`,
        );
      }
    }

    // 429: genuinely rate limited. Back off and retry the same shape.
    if (res.status === 429 && rateRetries < 3) {
      const wait = Number(res.headers.get('retry-after') ?? '0') * 1000 || 2000 * (rateRetries + 1);
      log.warn(`groq: rate limited, retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      rateRetries++;
      continue;
    }

    // 400 usually means the model rejected that response_format — try a looser one.
    if (res.status === 400) {
      log.debug(`groq: response_format #${shapeIndex + 1} rejected, loosening`, lastError);
      shapeIndex++;
      continue;
    }

    break;
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
