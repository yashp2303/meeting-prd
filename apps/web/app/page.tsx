import { getStore, checkConfig, getConfig, type MeetingRecord, type MeetingStage } from '@meeting-prd/core';

export const dynamic = 'force-dynamic';

const STAGE_STYLE: Record<MeetingStage, { cls: string; label: string }> = {
  scheduled: { cls: '', label: 'scheduled' },
  dispatched: { cls: 'info', label: 'bot sent' },
  recording: { cls: 'info', label: 'recording' },
  transcribed: { cls: 'info', label: 'transcribed' },
  drafted: { cls: 'warn', label: 'drafted' },
  awaiting_approval: { cls: 'warn', label: 'awaiting approval' },
  approved: { cls: 'ok', label: 'approved' },
  rejected: { cls: 'danger', label: 'rejected' },
  published: { cls: 'ok', label: 'published' },
  failed: { cls: 'danger', label: 'failed' },
};

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function MeetingCard({ record }: { record: MeetingRecord }) {
  const stage = STAGE_STYLE[record.stage];
  const counts = record.prd
    ? {
        features: record.prd.features.length,
        stories: record.prd.features.reduce((n, f) => n + f.stories.length, 0),
      }
    : null;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{record.event.title}</div>
          <div className="meta">
            {when(record.event.startsAt)}
            {record.event.meetCode ? ` · ${record.event.meetCode}` : ''}
            {record.transcript?.length ? ` · ${record.transcript.length} segments` : ''}
            {counts ? ` · ${counts.features} features / ${counts.stories} stories` : ''}
          </div>
        </div>
        <span className={`badge ${stage.cls}`}>{stage.label}</span>
      </div>

      {record.error ? (
        <div className="meta" style={{ color: 'var(--danger)', marginTop: 8 }}>
          {record.error}
        </div>
      ) : null}

      {record.prd || record.published?.length ? (
        <div className="row" style={{ marginTop: 12 }}>
          {record.prd ? (
            <a className="btn" href={`/prd/${encodeURIComponent(record.id)}`}>
              Review PRD
            </a>
          ) : null}
          {record.published?.length ? (
            <span className="badge ok">{record.published.length} ClickUp items</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default async function Dashboard() {
  const cfg = getConfig();
  const store = getStore();

  let records: MeetingRecord[] = [];
  let storeError: string | null = null;
  try {
    records = await store.list();
  } catch (err) {
    storeError = err instanceof Error ? err.message : String(err);
  }

  const checks = checkConfig(cfg);
  const missing = checks.filter((c) => c.required && !c.ok);

  return (
    <>
      <header className="top">
        <h1>meeting-prd</h1>
        <span className="badge">{store.kind} store</span>
      </header>
      <p className="sub">
        Meetings become PRDs become ClickUp tickets. Slack approves the middle step.
      </p>

      <div className="flow">
        Google Calendar → Vexa bot → Google Meet → transcript → Groq → PRD JSON → Slack approval →
        ClickUp features / stories / tasks
      </div>

      {missing.length > 0 && (
        <div className="notice bad">
          <strong>{missing.length} required setting(s) missing.</strong> The pipeline will not run
          until these are set. Run <code>meeting-prd init</code> locally, or add them as environment
          variables in your Vercel project.
          <table className="checks" style={{ marginTop: 12 }}>
            <tbody>
              {missing.map((c) => (
                <tr key={c.key}>
                  <td>{c.key}</td>
                  <td>{c.hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {store.kind === 'memory' && (
        <div className="notice">
          <strong>Using the in-memory store.</strong> State will not survive between requests. Add an
          Upstash Redis integration in Vercel (free tier is enough) and redeploy.
        </div>
      )}

      {storeError && (
        <div className="notice bad">
          <strong>Store unreadable.</strong> {storeError}
        </div>
      )}

      <h2>Meetings</h2>
      {records.length === 0 ? (
        <div className="empty">
          Nothing tracked yet.
          <br />
          The next scheduled tick will pick up any calendar event that has a Google Meet link.
        </div>
      ) : (
        records.map((r) => <MeetingCard key={r.id} record={r} />)
      )}
    </>
  );
}
