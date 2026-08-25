import { NextResponse } from 'next/server';
import { tick, getConfig, safeEqual, log } from '@meeting-prd/core';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * One pass of the pipeline.
 *
 * Meetings still have to be *discovered* on a schedule — Google Calendar push
 * channels need a domain-verified HTTPS endpoint — so the tick remains the
 * driver for scanning and bot dispatch. Once a bot is in a call the Vexa
 * webhook usually finishes the job first; this tick is then the safety net for
 * anything the webhook missed. Vercel Cron calls it on Pro; on Hobby the
 * bundled GitHub Actions workflow does instead.
 */
async function run(request: Request) {
  const cfg = getConfig();

  if (cfg.cronSecret) {
    const auth = request.headers.get('authorization') ?? '';
    const provided = auth.replace(/^Bearer\s+/i, '');
    const fromVercelCron = request.headers.get('x-vercel-cron') !== null;

    if (!fromVercelCron && !safeEqual(provided, cfg.cronSecret)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const started = Date.now();
  try {
    const result = await tick(cfg);
    const summary = {
      ok: true,
      ms: Date.now() - started,
      ...result,
    };
    log.info('tick complete', summary);
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`tick failed: ${message}`);
    return NextResponse.json({ ok: false, error: message, ms: Date.now() - started }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
