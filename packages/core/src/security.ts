import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export type Decision = 'approve' | 'reject';

export interface ApprovalClaims {
  id: string; // meeting record id
  decision: Decision;
  exp: number; // unix seconds
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * Slack incoming webhooks are send-only — they cannot deliver button clicks back
 * to us. So an approval is instead a signed, single-purpose, expiring URL. The
 * HMAC covers the meeting id, the decision, and the expiry, so a reject link
 * cannot be edited into an approve link.
 */
export function signApproval(
  claims: Omit<ApprovalClaims, 'exp'> & { exp?: number },
  secret: string,
  ttlSeconds = 60 * 60 * 24 * 7,
): string {
  if (!secret) throw new Error('APPROVAL_SECRET is not set — refusing to sign an unprotected link');
  const payload: ApprovalClaims = {
    id: claims.id,
    decision: claims.decision,
    exp: claims.exp ?? Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyApproval(
  token: string,
  secret: string,
): { ok: true; claims: ApprovalClaims } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: 'server missing APPROVAL_SECRET' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed token' };
  const [body, sig] = parts as [string, string];

  const expected = createHmac('sha256', secret).update(body).digest();
  let provided: Buffer;
  try {
    provided = fromB64url(sig);
  } catch {
    return { ok: false, reason: 'malformed signature' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad signature' };
  }

  let claims: ApprovalClaims;
  try {
    claims = JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed payload' };
  }
  if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'link expired' };
  }
  if (claims.decision !== 'approve' && claims.decision !== 'reject') {
    return { ok: false, reason: 'unknown decision' };
  }
  return { ok: true, claims };
}

/** Constant-time bearer comparison for the cron endpoint. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}
