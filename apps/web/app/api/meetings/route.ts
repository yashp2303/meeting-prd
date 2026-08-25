import { NextResponse } from 'next/server';
import { getStore, getConfig, safeEqual } from '@meeting-prd/core';

export const dynamic = 'force-dynamic';

/** Read-only JSON feed of tracked meetings — used by `meeting-prd status --remote`. */
export async function GET(request: Request) {
  const cfg = getConfig();

  if (cfg.cronSecret) {
    const provided = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!safeEqual(provided, cfg.cronSecret)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const records = await getStore().list();
  return NextResponse.json({
    count: records.length,
    meetings: records.map((r) => ({
      id: r.id,
      stage: r.stage,
      title: r.event.title,
      startsAt: r.event.startsAt,
      meetCode: r.event.meetCode,
      segments: r.transcript?.length ?? 0,
      prdTitle: r.prd?.title ?? null,
      features: r.prd?.features.length ?? 0,
      published: r.published?.length ?? 0,
      error: r.error ?? null,
      updatedAt: r.updatedAt,
    })),
  });
}
