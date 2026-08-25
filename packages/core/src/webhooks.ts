import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { getConfig } from './config.js';
import { log } from './logger.js';

/**
 * Vexa webhook receipt.
 *
 * Vexa's docs describe delivery as "HMAC-signed payloads with a retry queue"
 * but never state the header names or the signed string, and the dashboard
 * secret is `whsec_`-prefixed. That prefix is the Standard Webhooks / Svix
 * convention, so that scheme is tried first, with two commoner fallbacks
 * behind it. Any request that matches none of them is rejected *and* logs the
 * header names it did carry, so an unknown scheme is a five-minute fix rather
 * than a silent outage.
 */

export type VexaEvent =
  | 'meeting.completed'
  | 'meeting.started'
  | 'bot.failed'
  | 'meeting.status_change';

export interface VexaWebhookPayload {
  event?: string;
  type?: string;
  platform?: string;
  native_meeting_id?: string;
  meeting_id?: string;
  status?: string;
  [k: string]: unknown;
}

export interface VerifyResult {
  ok: boolean;
  scheme?: 'standard-webhooks' | 'raw-body-hex' | 'raw-body-base64' | 'unsigned';
  reason?: string;
}

function safeCompare(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `whsec_<base64>` — the key is the decoded base64, not the literal string. */
function secretKey(secret: string): Buffer {
  const bare = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  try {
    const decoded = Buffer.from(bare, 'base64');
    // A base64 decode of non-base64 text yields garbage rather than throwing,
    // so only trust it if it round-trips.
    if (decoded.length > 0 && decoded.toString('base64').replace(/=+$/, '') === bare.replace(/=+$/, '')) {
      return decoded;
    }
  } catch {
    /* fall through */
  }
  return Buffer.from(bare, 'utf8');
}

/** Standard Webhooks: HMAC over `{id}.{timestamp}.{body}`, header `v1,<base64>`. */
function verifyStandardWebhooks(
  rawBody: string,
  headers: Headers,
  secret: string,
): VerifyResult | null {
  const id = headers.get('webhook-id') ?? headers.get('svix-id');
  const timestamp = headers.get('webhook-timestamp') ?? headers.get('svix-timestamp');
  const signature = headers.get('webhook-signature') ?? headers.get('svix-signature');
  if (!id || !timestamp || !signature) return null;

  // Reject stale deliveries so a captured request cannot be replayed later.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (Number.isFinite(age) && age > 60 * 10) {
    return { ok: false, reason: `timestamp is ${Math.round(age)}s away from now` };
  }

  const expected = createHmac('sha256', secretKey(secret))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest();

  // The header may carry several space-delimited versioned signatures.
  for (const part of signature.split(' ')) {
    const value = part.includes(',') ? part.slice(part.indexOf(',') + 1) : part;
    try {
      if (safeCompare(Buffer.from(value, 'base64'), expected)) {
        return { ok: true, scheme: 'standard-webhooks' };
      }
    } catch {
      /* try the next one */
    }
  }
  return { ok: false, reason: 'standard-webhooks signature mismatch' };
}

/** Fallback: a plain HMAC of the raw body in a vendor-named header. */
function verifyRawBody(rawBody: string, headers: Headers, secret: string): VerifyResult | null {
  const header =
    headers.get('x-vexa-signature') ??
    headers.get('x-webhook-signature') ??
    headers.get('x-hub-signature-256') ??
    headers.get('x-signature');
  if (!header) return null;

  const provided = header.replace(/^sha256=/i, '').trim();
  for (const key of [secretKey(secret), Buffer.from(secret, 'utf8')]) {
    const mac = createHmac('sha256', key).update(rawBody).digest();
    try {
      if (safeCompare(Buffer.from(provided, 'hex'), mac)) {
        return { ok: true, scheme: 'raw-body-hex' };
      }
    } catch {
      /* not hex */
    }
    try {
      if (safeCompare(Buffer.from(provided, 'base64'), mac)) {
        return { ok: true, scheme: 'raw-body-base64' };
      }
    } catch {
      /* not base64 */
    }
  }
  return { ok: false, reason: 'raw-body signature mismatch' };
}

export function verifyVexaWebhook(
  rawBody: string,
  headers: Headers,
  cfg: Config = getConfig(),
): VerifyResult {
  if (!cfg.vexaWebhookSecret) {
    // No secret configured. Accept, but say so loudly — an unauthenticated
    // endpoint lets anyone inject a meeting into the pipeline.
    log.warn(
      'VEXA_WEBHOOK_SECRET is not set — accepting an unverified webhook. ' +
        'Set it to the whsec_ value from the Vexa dashboard.',
    );
    return { ok: true, scheme: 'unsigned' };
  }

  const attempts = [
    verifyStandardWebhooks(rawBody, headers, cfg.vexaWebhookSecret),
    verifyRawBody(rawBody, headers, cfg.vexaWebhookSecret),
  ].filter((r): r is VerifyResult => r !== null);

  const passed = attempts.find((r) => r.ok);
  if (passed) return passed;

  if (attempts.length === 0) {
    // No recognised signature header at all. Log what did arrive so the scheme
    // can be identified from one real delivery.
    const names: string[] = [];
    headers.forEach((_value, name) => {
      if (!['accept', 'host', 'connection', 'content-length'].includes(name)) names.push(name);
    });
    log.error(`vexa webhook: no known signature header. Headers received: ${names.join(', ')}`);
    if (cfg.vexaWebhookInsecure) {
      log.warn('VEXA_WEBHOOK_INSECURE=1 — processing anyway. Do not leave this on.');
      return { ok: true, scheme: 'unsigned' };
    }
    return { ok: false, reason: `no recognised signature header (got: ${names.join(', ')})` };
  }

  return { ok: false, reason: attempts.map((a) => a.reason).join('; ') };
}

/** Event and meeting identifiers, dug out defensively — the shape is undocumented. */
export function parseVexaPayload(payload: VexaWebhookPayload): {
  event: string;
  platform: string;
  meetCode: string | null;
} {
  const event = String(payload.event ?? payload.type ?? 'unknown');

  const nested = (payload.data ?? payload.meeting ?? {}) as Record<string, unknown>;
  const meetCode =
    payload.native_meeting_id ??
    (nested.native_meeting_id as string | undefined) ??
    (nested.meeting_id as string | undefined) ??
    payload.meeting_id ??
    null;

  const platform = String(
    payload.platform ?? (nested.platform as string | undefined) ?? 'google_meet',
  );

  return { event, platform, meetCode: meetCode ? String(meetCode) : null };
}
