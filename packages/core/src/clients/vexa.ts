import type { TranscriptSegment } from '../types.js';
import { getConfig, type Config } from '../config.js';
import { log } from '../logger.js';

/**
 * Vexa drops a headless bot into the Meet call and transcribes it.
 *
 * Note: Vexa exposes no outbound webhooks — transcripts are poll-only. That is
 * why the whole pipeline is driven by a repeating tick rather than callbacks.
 */

export type Platform = 'google_meet' | 'teams' | 'zoom' | 'jitsi';

export interface BotStatus {
  platform?: string;
  native_meeting_id?: string;
  status?: string;
  [k: string]: unknown;
}

function headers(cfg: Config): Record<string, string> {
  if (!cfg.vexaApiKey) throw new Error('VEXA_API_KEY is not set');
  return { 'X-API-Key': cfg.vexaApiKey, 'Content-Type': 'application/json' };
}

async function request<T>(
  path: string,
  init: RequestInit,
  cfg: Config,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const url = `${cfg.vexaBaseUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...headers(cfg), ...(init.headers ?? {}) } });
  } catch (err) {
    return { ok: false, status: 0, error: `network error reaching Vexa at ${cfg.vexaBaseUrl}: ${err}` };
  }

  const text = await res.text();
  if (!res.ok) {
    // 503 from Vexa specifically means no speech-to-text backend is wired up.
    const hint =
      res.status === 503
        ? ' — Vexa has no transcription backend configured (self-hosted: check your Whisper service)'
        : '';
    return { ok: false, status: res.status, error: `${res.status} ${text.slice(0, 300)}${hint}` };
  }

  try {
    return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
  } catch {
    return { ok: false, status: res.status, error: `non-JSON response: ${text.slice(0, 200)}` };
  }
}

export interface SendBotOptions {
  meetCode: string;
  platform?: Platform;
  botName?: string;
  language?: string;
}

export async function sendBot(
  opts: SendBotOptions,
  cfg: Config = getConfig(),
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const body = {
    platform: opts.platform ?? 'google_meet',
    native_meeting_id: opts.meetCode,
    bot_name: opts.botName ?? cfg.vexaBotName,
    language: opts.language ?? cfg.vexaLanguage,
  };
  log.info(`vexa: dispatching bot to ${body.platform}/${body.native_meeting_id}`);
  return request('/bots', { method: 'POST', body: JSON.stringify(body) }, cfg);
}

export async function stopBot(
  meetCode: string,
  platform: Platform = 'google_meet',
  cfg: Config = getConfig(),
) {
  return request(`/bots/${platform}/${encodeURIComponent(meetCode)}`, { method: 'DELETE' }, cfg);
}

export async function botStatus(cfg: Config = getConfig()) {
  return request<BotStatus[] | { bots?: BotStatus[] }>('/bots/status', { method: 'GET' }, cfg);
}

/**
 * Vexa's transcript payload shape varies a little between the open-core build
 * and the hosted one, so normalise defensively rather than trusting one schema.
 */
function normaliseSegments(payload: unknown): TranscriptSegment[] {
  const rows: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { segments?: unknown[] })?.segments)
      ? (payload as { segments: unknown[] }).segments
      : Array.isArray((payload as { transcripts?: unknown[] })?.transcripts)
        ? (payload as { transcripts: unknown[] }).transcripts
        : [];

  return rows
    .map((row): TranscriptSegment | null => {
      if (typeof row !== 'object' || row === null) return null;
      const r = row as Record<string, unknown>;
      const text = (r.text ?? r.content ?? r.transcript) as string | undefined;
      if (!text || !String(text).trim()) return null;

      const segment: TranscriptSegment = {
        speaker: String(r.speaker ?? r.speaker_name ?? r.participant ?? 'Unknown'),
        text: String(text).trim(),
      };
      if (r.time !== undefined) segment.time = String(r.time);
      else if (r.start !== undefined) segment.time = String(r.start);
      return segment;
    })
    .filter((s): s is TranscriptSegment => s !== null);
}

export async function getTranscript(
  meetCode: string,
  platform: Platform = 'google_meet',
  cfg: Config = getConfig(),
): Promise<{ ok: true; segments: TranscriptSegment[] } | { ok: false; status: number; error: string }> {
  const res = await request<unknown>(
    `/transcripts/${platform}/${encodeURIComponent(meetCode)}`,
    { method: 'GET' },
    cfg,
  );
  if (!res.ok) return res;
  return { ok: true, segments: normaliseSegments(res.data) };
}

export function transcriptToText(segments: TranscriptSegment[]): string {
  return segments.map((s) => `${s.speaker}: ${s.text}`).join('\n');
}
