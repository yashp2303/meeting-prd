import type { MeetingRecord, Prd, PublishedTicket } from '../types.js';
import { getConfig, type Config } from '../config.js';
import { signApproval } from '../security.js';
import { log } from '../logger.js';

type Block = Record<string, unknown>;

function section(text: string): Block {
  return { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } };
}

function context(text: string): Block {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: text.slice(0, 2900) }] };
}

async function post(blocks: Block[], fallback: string, cfg: Config): Promise<void> {
  if (!cfg.slackWebhookUrl) {
    log.warn('SLACK_WEBHOOK_URL not set — skipping Slack post');
    return;
  }
  const res = await fetch(cfg.slackWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: fallback, blocks }),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

function countWork(prd: Prd): { features: number; stories: number; tasks: number; points: number } {
  let stories = 0;
  let tasks = 0;
  let points = 0;
  for (const f of prd.features) {
    stories += f.stories.length;
    for (const s of f.stories) {
      tasks += s.tasks.length;
      points += s.estimate_points || 0;
    }
  }
  return { features: prd.features.length, stories, tasks, points };
}

/**
 * Posts the approval card.
 *
 * The webhook is send-only, so Approve/Reject are signed HMAC links back to the
 * web app rather than Block Kit buttons (which would need a full Slack app with
 * an interactivity endpoint and signing secret).
 */
export async function postApprovalRequest(
  record: MeetingRecord,
  cfg: Config = getConfig(),
): Promise<void> {
  const prd = record.prd;
  if (!prd) throw new Error(`Meeting ${record.id} has no PRD to approve`);

  const approveToken = signApproval({ id: record.id, decision: 'approve' }, cfg.approvalSecret);
  const rejectToken = signApproval({ id: record.id, decision: 'reject' }, cfg.approvalSecret);
  const approveUrl = `${cfg.appBaseUrl}/api/decision?token=${encodeURIComponent(approveToken)}`;
  const rejectUrl = `${cfg.appBaseUrl}/api/decision?token=${encodeURIComponent(rejectToken)}`;
  const reviewUrl = `${cfg.appBaseUrl}/prd/${encodeURIComponent(record.id)}`;

  const n = countWork(prd);
  const featureLines = prd.features
    .slice(0, 8)
    .map((f) => `• *${f.name}* \`${f.priority}\` — ${f.stories.length} stories`)
    .join('\n');
  const more = prd.features.length > 8 ? `\n_…and ${prd.features.length - 8} more_` : '';

  const blocks: Block[] = [
    { type: 'header', text: { type: 'plain_text', text: '📝 PRD ready for approval', emoji: true } },
    section(`*${prd.title}*\n${prd.summary}`),
    context(
      `From *${record.event.title}* · ${new Date(record.event.startsAt).toLocaleString()} · ` +
        `${record.transcript?.length ?? 0} transcript segments · model \`${record.prdModel ?? 'n/a'}\``,
    ),
    { type: 'divider' },
    section(`*Problem*\n${prd.problem_statement}`),
    section(
      `*Proposed work*\n${featureLines}${more}\n\n` +
        `_Totals: ${n.features} features · ${n.stories} stories · ${n.tasks} tasks · ${n.points} points_`,
    ),
  ];

  if (prd.open_questions.length) {
    blocks.push(
      section(`*Open questions*\n${prd.open_questions.slice(0, 5).map((q) => `• ${q}`).join('\n')}`),
    );
  }

  blocks.push(
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: '✅ Approve & create in ClickUp', emoji: true },
          url: approveUrl,
          action_id: 'approve',
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: '❌ Reject', emoji: true },
          url: rejectUrl,
          action_id: 'reject',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔍 Review full PRD', emoji: true },
          url: reviewUrl,
          action_id: 'review',
        },
      ],
    },
    context('Links are single-purpose, signed, and expire in 7 days.'),
  );

  await post(blocks, `PRD ready for approval: ${prd.title}`, cfg);
  log.info(`slack: approval posted for ${record.id}`);
}

export async function postPublished(
  record: MeetingRecord,
  tickets: PublishedTicket[],
  cfg: Config = getConfig(),
): Promise<void> {
  const features = tickets.filter((t) => t.kind === 'feature');
  const lines = features.map((f) => `• <${f.url}|${f.title}>`).join('\n');
  const counts = {
    feature: features.length,
    story: tickets.filter((t) => t.kind === 'story').length,
    task: tickets.filter((t) => t.kind === 'task').length,
  };

  await post(
    [
      { type: 'header', text: { type: 'plain_text', text: '🚀 Created in ClickUp', emoji: true } },
      section(`*${record.prd?.title ?? record.event.title}*\n${lines || '_No parent tasks created_'}`),
      context(
        `${counts.feature} features · ${counts.story} stories · ${counts.task} tasks — ` +
          `from *${record.event.title}*`,
      ),
    ],
    `Created ${tickets.length} ClickUp items`,
    cfg,
  );
}

export async function postRejected(record: MeetingRecord, cfg: Config = getConfig()): Promise<void> {
  await post(
    [
      section(
        `🚫 *PRD rejected* — _${record.prd?.title ?? record.event.title}_\n` +
          `Nothing was created in ClickUp. Re-run with \`meeting-prd redraft ${record.id}\`.`,
      ),
    ],
    'PRD rejected',
    cfg,
  );
}

export async function postError(
  title: string,
  detail: string,
  cfg: Config = getConfig(),
): Promise<void> {
  await post([section(`⚠️ *${title}*\n\`\`\`${detail.slice(0, 1500)}\`\`\``)], title, cfg);
}
