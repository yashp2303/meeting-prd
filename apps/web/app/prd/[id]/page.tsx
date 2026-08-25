import { getStore, getConfig, signApproval, type Prd } from '@meeting-prd/core';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

function FeatureBlock({ feature }: { feature: Prd['features'][number] }) {
  return (
    <div className={`feature ${feature.priority}`}>
      <h3>
        {feature.name} <span className="badge">{feature.priority}</span>
      </h3>
      <p>{feature.description}</p>
      {feature.rationale && (
        <blockquote>
          <em>{feature.rationale}</em>
        </blockquote>
      )}

      {feature.acceptance_criteria.length > 0 && (
        <>
          <strong>Acceptance criteria</strong>
          <ul>
            {feature.acceptance_criteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </>
      )}

      {feature.stories.map((story, i) => (
        <div className="story" key={i}>
          <div className="card-head">
            <strong>{story.title}</strong>
            <span className="badge">{story.estimate_points} pts</span>
          </div>
          <p style={{ margin: '8px 0' }}>
            As a <strong>{story.as_a}</strong>, I want <strong>{story.i_want}</strong>, so that{' '}
            <strong>{story.so_that}</strong>.
          </p>
          {story.acceptance_criteria.length > 0 && (
            <ul>
              {story.acceptance_criteria.map((c, j) => (
                <li key={j}>{c}</li>
              ))}
            </ul>
          )}
          {story.tasks.length > 0 && (
            <>
              <strong style={{ fontSize: 13 }}>Tasks</strong>
              <ul>
                {story.tasks.map((t, j) => (
                  <li key={j}>
                    {t.title} <code>{t.estimate_hours}h</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <>
      <h2>{title}</h2>
      <ul>
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </>
  );
}

export default async function PrdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cfg = getConfig();
  const record = await getStore().get(decodeURIComponent(id));

  if (!record) notFound();
  const prd = record.prd;
  if (!prd) {
    return (
      <>
        <a href="/">← all meetings</a>
        <h1 style={{ marginTop: 20 }}>{record.event.title}</h1>
        <div className="notice">
          No PRD has been generated yet. Current stage: <code>{record.stage}</code>.
        </div>
      </>
    );
  }

  const decidable = record.stage === 'awaiting_approval' || record.stage === 'drafted';
  const approveHref = decidable
    ? `/api/decision?token=${encodeURIComponent(
        signApproval({ id: record.id, decision: 'approve' }, cfg.approvalSecret),
      )}`
    : null;
  const rejectHref = decidable
    ? `/api/decision?token=${encodeURIComponent(
        signApproval({ id: record.id, decision: 'reject' }, cfg.approvalSecret),
      )}`
    : null;

  return (
    <div className="prose">
      <a href="/">← all meetings</a>

      <header className="top" style={{ marginTop: 20 }}>
        <h1>{prd.title}</h1>
        <span className="badge">{record.stage}</span>
      </header>
      <p className="sub">
        From <strong>{record.event.title}</strong> ·{' '}
        {new Date(record.event.startsAt).toLocaleString()} · {record.transcript?.length ?? 0}{' '}
        transcript segments · model <code>{record.prdModel ?? 'n/a'}</code>
      </p>

      {decidable && approveHref && rejectHref && (
        <div className="notice">
          <strong>This PRD is awaiting a decision.</strong>
          <div className="row" style={{ marginTop: 12 }}>
            <a className="btn primary" href={approveHref}>
              Approve &amp; create in ClickUp
            </a>
            <a className="btn danger" href={rejectHref}>
              Reject
            </a>
          </div>
        </div>
      )}

      {record.published && record.published.length > 0 && (
        <div className="notice ok">
          <strong>Published to ClickUp</strong> — {record.published.length} items.
          <ul>
            {record.published
              .filter((t) => t.kind === 'feature')
              .map((t) => (
                <li key={t.clickupId}>
                  <a href={t.url} target="_blank" rel="noreferrer">
                    {t.title}
                  </a>
                </li>
              ))}
          </ul>
        </div>
      )}

      <p>{prd.summary}</p>

      <h2>Problem</h2>
      <p>{prd.problem_statement}</p>

      <List title="Goals" items={prd.goals} />
      <List title="Non-goals" items={prd.non_goals} />
      <List title="Success metrics" items={prd.success_metrics} />
      <List title="Decisions made" items={prd.decisions} />

      <h2>Features</h2>
      {prd.features.length === 0 ? (
        <div className="empty">
          The model found no concrete features in this transcript. See open questions below.
        </div>
      ) : (
        prd.features.map((f, i) => <FeatureBlock key={i} feature={f} />)
      )}

      <List title="Risks" items={prd.risks} />
      <List title="Open questions" items={prd.open_questions} />
      <List title="Stakeholders" items={prd.stakeholders} />

      <h2>Timeline</h2>
      <p>{prd.timeline}</p>
    </div>
  );
}
