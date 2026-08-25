import { NextResponse } from 'next/server';
import {
  verifyVexaWebhook,
  parseVexaPayload,
  handleVexaEvent,
  getConfig,
  log,
  type VexaWebhookPayload,
} from '@meeting-prd/core';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Vexa webhook receiver.
 *
 * Paste this URL into Vexa → Webhooks → Endpoint URL, and the dashboard's
 * whsec_ value into VEXA_WEBHOOK_SECRET.
 *
 * Note that Vexa's own Delivery History panel is known to show nothing even for
 * successful deliveries (Vexa issue #841) — check this app's logs, or GET this
 * route, rather than trusting that panel.
 */
export async function POST(request: Request) {
  const cfg = getConfig();

  // The signature covers the exact bytes, so the body must be read as text
  // before anything parses it.
  const rawBody = await request.text();

  const verified = verifyVexaWebhook(rawBody, request.headers, cfg);
  if (!verified.ok) {
    log.error(`vexa webhook rejected: ${verified.reason}`);
    log.error(`vexa webhook body was: ${rawBody.slice(0, 400)}`);

    // Vexa's dashboard "Test" button fires from the browser and sends no
    // signature, so a 401 here is expected and does not mean the endpoint is
    // misconfigured. Say so in the response rather than leaving a bare 401.
    const unsigned = verified.reason?.includes('no recognised signature header');
    return NextResponse.json(
      {
        ok: false,
        error: verified.reason,
        ...(unsigned
          ? {
              likelyCause:
                "This request carried no signature header. Vexa's dashboard Test button " +
                'sends unsigned requests from the browser, so it will always fail while ' +
                'VEXA_WEBHOOK_SECRET is set.',
              options: [
                'Set VEXA_WEBHOOK_INSECURE=1 to accept unsigned deliveries (endpoint becomes open).',
                'Or leave verification on and ignore the Test button — real deliveries from ' +
                  "Vexa's queue are signed and will be accepted.",
              ],
            }
          : {}),
      },
      { status: 401 },
    );
  }

  let payload: VexaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as VexaWebhookPayload;
  } catch {
    return NextResponse.json({ ok: false, error: 'body is not JSON' }, { status: 400 });
  }

  const { event, platform, meetCode } = parseVexaPayload(payload);
  log.info(`vexa webhook: ${event} for ${meetCode ?? 'unknown meeting'} (${verified.scheme})`);

  if (!meetCode) {
    // Ack rather than 4xx — a retry would not help, and Vexa retries failures.
    log.warn(`vexa webhook: no meeting id in payload: ${rawBody.slice(0, 300)}`);
    return NextResponse.json({ ok: true, ignored: 'no meeting id in payload' });
  }

  try {
    const result = await handleVexaEvent(
      event,
      meetCode,
      platform as 'google_meet',
      cfg,
    );
    return NextResponse.json({ ok: true, event, meetCode, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`vexa webhook handler failed: ${message}`);
    // 500 so Vexa's retry queue tries again.
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/** Lets you confirm the endpoint is reachable from a browser or the Test button. */
export async function GET() {
  const cfg = getConfig();
  return NextResponse.json({
    ok: true,
    endpoint: `${cfg.appBaseUrl}/api/webhooks/vexa`,
    signatureVerification: cfg.vexaWebhookSecret
      ? 'enabled'
      : 'DISABLED — set VEXA_WEBHOOK_SECRET',
    insecureModeEnabled: cfg.vexaWebhookInsecure,
    subscribeTo: ['meeting.completed', 'bot.failed', 'meeting.started'],
    note: "Vexa's Delivery History panel is known to show zero even for successful deliveries (issue #841).",
  });
}
