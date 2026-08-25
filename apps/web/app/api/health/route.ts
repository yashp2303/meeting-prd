import { NextResponse } from 'next/server';
import { checkConfig, getConfig, getStore } from '@meeting-prd/core';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cfg = getConfig();
  const checks = checkConfig(cfg);
  const missingRequired = checks.filter((c) => c.required && !c.ok).map((c) => c.key);

  const store = getStore();
  let recordCount: number | null = null;
  let storeError: string | null = null;
  try {
    recordCount = (await store.list()).length;
  } catch (err) {
    storeError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(
    {
      ok: missingRequired.length === 0 && !storeError,
      store: { kind: store.kind, records: recordCount, error: storeError, persistent: store.kind !== 'memory' },
      model: cfg.groqModel,
      vexaBaseUrl: cfg.vexaBaseUrl,
      appBaseUrl: cfg.appBaseUrl,
      autoApprove: cfg.autoApprove,
      missingRequired,
      checks: checks.map(({ key, label, ok, required }) => ({ key, label, ok, required })),
    },
    { status: missingRequired.length === 0 ? 200 : 503 },
  );
}
