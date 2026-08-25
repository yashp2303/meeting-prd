import type { MeetingRecord, TickResult } from './types.js';
import { getConfig, type Config } from './config.js';
import { getStore, type Store } from './store.js';
import { log } from './logger.js';
import { listUpcomingMeetings } from './clients/google-calendar.js';
import { sendBot, getTranscript, stopBot } from './clients/vexa.js';
import { generatePrd } from './prd.js';
import { postApprovalRequest, postPublished, postRejected } from './clients/slack.js';
import { publishPrd } from './clients/clickup.js';

const MINUTE = 60_000;

function now() {
  return Date.now();
}

async function save(store: Store, record: MeetingRecord, patch: Partial<MeetingRecord>) {
  const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
  await store.put(next);
  return next;
}

/**
 * Step 1 — read the calendar and register anything with a Meet link.
 * Records are keyed by calendar event id, so re-scanning is idempotent.
 */
export async function scan(cfg: Config = getConfig(), store: Store = getStore()): Promise<string[]> {
  const events = await listUpcomingMeetings(
    { windowMinutes: Math.max(cfg.lookaheadMinutes * 3, 60) },
    cfg,
  );
  const added: string[] = [];

  for (const event of events) {
    const existing = await store.get(event.id);
    if (existing) {
      // Keep title/time fresh in case the invite was edited, but never rewind stage.
      if (
        existing.event.startsAt !== event.startsAt ||
        existing.event.endsAt !== event.endsAt ||
        existing.event.title !== event.title
      ) {
        await save(store, existing, { event });
      }
      continue;
    }

    await store.put({
      id: event.id,
      stage: 'scheduled',
      event,
      updatedAt: new Date().toISOString(),
    });
    added.push(event.id);
    log.info(`scan: registered "${event.title}" (${event.meetCode})`);
  }
  return added;
}

/** Step 2 — send the Vexa bot once the meeting is close enough to starting. */
async function dispatchDue(cfg: Config, store: Store, result: TickResult) {
  const records = (await store.list()).filter((r) => r.stage === 'scheduled');

  for (const record of records) {
    const startsAt = new Date(record.event.startsAt).getTime();
    const endsAt = new Date(record.event.endsAt).getTime();

    if (now() > endsAt) {
      await save(store, record, { stage: 'failed', error: 'Meeting ended before a bot was sent' });
      continue;
    }
    if (startsAt - now() > cfg.lookaheadMinutes * MINUTE) continue;
    if (!record.event.meetCode) {
      await save(store, record, { stage: 'failed', error: 'No Google Meet code on this event' });
      continue;
    }

    const res = await sendBot({ meetCode: record.event.meetCode }, cfg);
    if (res.ok) {
      await save(store, record, { stage: 'dispatched', botDispatchedAt: new Date().toISOString() });
      result.dispatched.push(record.id);
    } else {
      // A bot already in the call is success, not failure.
      if (res.status === 409) {
        await save(store, record, { stage: 'dispatched', botDispatchedAt: new Date().toISOString() });
        result.dispatched.push(record.id);
      } else {
        await save(store, record, { stage: 'failed', error: `Vexa: ${res.error}` });
        result.errors.push({ id: record.id, message: res.error });
      }
    }
  }
}

/**
 * Step 3 — poll transcripts. Vexa has no webhooks, so this is the only way to
 * learn a meeting has content or has finished.
 */
async function collectTranscripts(cfg: Config, store: Store, result: TickResult) {
  const records = (await store.list()).filter(
    (r) => r.stage === 'dispatched' || r.stage === 'recording',
  );

  for (const record of records) {
    if (!record.event.meetCode) continue;

    const res = await getTranscript(record.event.meetCode, 'google_meet', cfg);
    if (!res.ok) {
      log.debug(`collect: ${record.id} transcript not ready (${res.error})`);
      continue;
    }

    const segments = res.segments;
    const grew = segments.length !== (record.lastTranscriptLength ?? -1);
    const endsAt = new Date(record.event.endsAt).getTime();
    const startsAt = new Date(record.event.startsAt).getTime();

    const lastChange = record.transcriptUpdatedAt
      ? new Date(record.transcriptUpdatedAt).getTime()
      : record.botDispatchedAt
        ? new Date(record.botDispatchedAt).getTime()
        : now();

    const idleFor = now() - lastChange;
    const pastScheduledEnd = now() > endsAt;
    const startedLongEnoughAgo = now() > startsAt + 3 * MINUTE;

    // A meeting is over when the calendar says so, or when the transcript has
    // been static long enough that the room is clearly empty.
    const ended =
      segments.length > 0 &&
      !grew &&
      (pastScheduledEnd || (startedLongEnoughAgo && idleFor > cfg.idleTimeoutMinutes * MINUTE));

    if (grew) {
      await save(store, record, {
        stage: 'recording',
        transcript: segments,
        lastTranscriptLength: segments.length,
        transcriptUpdatedAt: new Date().toISOString(),
      });
      result.collected.push(record.id);
      continue;
    }

    if (ended) {
      await stopBot(record.event.meetCode, 'google_meet', cfg).catch(() => undefined);
      await save(store, record, { stage: 'transcribed', transcript: segments });
      log.info(`collect: "${record.event.title}" ended with ${segments.length} segments`);
      continue;
    }

    // Nothing ever arrived and the slot is well past — give up rather than poll forever.
    if (segments.length === 0 && now() > endsAt + 15 * MINUTE) {
      await stopBot(record.event.meetCode, 'google_meet', cfg).catch(() => undefined);
      await save(store, record, {
        stage: 'failed',
        error: 'No transcript was produced — the bot may never have been admitted to the call',
      });
      result.errors.push({ id: record.id, message: 'empty transcript' });
    }
  }
}

/** Step 4 — Groq turns the transcript into a PRD. */
async function draftPrds(cfg: Config, store: Store, result: TickResult) {
  const records = (await store.list()).filter((r) => r.stage === 'transcribed');

  for (const record of records) {
    try {
      const { prd, model } = await generatePrd(record.event, record.transcript ?? [], cfg);
      await save(store, record, {
        stage: 'drafted',
        prd,
        prdModel: model,
        prdGeneratedAt: new Date().toISOString(),
      });
      result.drafted.push(record.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await save(store, record, { stage: 'failed', error: `PRD generation: ${message}` });
      result.errors.push({ id: record.id, message });
    }
  }
}

/** Step 5 — ask Slack for approval, or skip straight through if AUTO_APPROVE. */
async function requestApprovals(cfg: Config, store: Store, result: TickResult) {
  const records = (await store.list()).filter((r) => r.stage === 'drafted');

  for (const record of records) {
    try {
      if (cfg.autoApprove) {
        await save(store, record, {
          stage: 'approved',
          decidedAt: new Date().toISOString(),
          decidedBy: 'auto-approve',
        });
        continue;
      }
      await postApprovalRequest(record, cfg);
      await save(store, record, {
        stage: 'awaiting_approval',
        slackPostedAt: new Date().toISOString(),
      });
      result.posted.push(record.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await save(store, record, { error: `Slack: ${message}` });
      result.errors.push({ id: record.id, message });
    }
  }
}

/** Step 6 — approved PRDs become ClickUp tickets. */
async function publishApproved(cfg: Config, store: Store, result: TickResult) {
  const records = (await store.list()).filter((r) => r.stage === 'approved');

  for (const record of records) {
    if (!record.prd) {
      await save(store, record, { stage: 'failed', error: 'Approved with no PRD attached' });
      continue;
    }
    try {
      const tickets = await publishPrd(
        record.prd,
        { reviewUrl: `${cfg.appBaseUrl}/prd/${encodeURIComponent(record.id)}` },
        cfg,
      );
      const updated = await save(store, record, {
        stage: 'published',
        published: tickets,
        publishedAt: new Date().toISOString(),
      });
      await postPublished(updated, tickets, cfg).catch((e) => log.warn(`slack notify failed: ${e}`));
      result.published.push(record.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await save(store, record, { stage: 'failed', error: `ClickUp: ${message}` });
      result.errors.push({ id: record.id, message });
    }
  }
}

/**
 * One full pass of the pipeline. Safe to call repeatedly — every stage
 * transition is guarded by the record's own stage, so overlapping ticks
 * cannot double-publish.
 */
export async function tick(
  cfg: Config = getConfig(),
  store: Store = getStore(),
): Promise<TickResult> {
  const result: TickResult = {
    scanned: 0,
    dispatched: [],
    collected: [],
    drafted: [],
    posted: [],
    published: [],
    errors: [],
  };

  try {
    const added = await scan(cfg, store);
    result.scanned = added.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`scan failed: ${message}`);
    result.errors.push({ id: 'scan', message });
  }

  await dispatchDue(cfg, store, result);
  await collectTranscripts(cfg, store, result);
  await draftPrds(cfg, store, result);
  await requestApprovals(cfg, store, result);
  await publishApproved(cfg, store, result);

  return result;
}

/** Called by the signed Slack link. Publishing happens on the next tick. */
export async function applyDecision(
  id: string,
  decision: 'approve' | 'reject',
  by = 'slack',
  cfg: Config = getConfig(),
  store: Store = getStore(),
): Promise<{ ok: boolean; record?: MeetingRecord; message: string }> {
  const record = await store.get(id);
  if (!record) return { ok: false, message: 'Unknown meeting — it may have been cleared.' };

  if (record.stage === 'published') {
    return { ok: true, record, message: 'Already published to ClickUp.' };
  }
  if (record.stage === 'approved' || record.stage === 'rejected') {
    return { ok: true, record, message: `Already ${record.stage}.` };
  }
  if (record.stage !== 'awaiting_approval' && record.stage !== 'drafted') {
    return { ok: false, record, message: `This PRD is not awaiting a decision (stage: ${record.stage}).` };
  }

  const updated = await save(store, record, {
    stage: decision === 'approve' ? 'approved' : 'rejected',
    decidedAt: new Date().toISOString(),
    decidedBy: by,
  });

  if (decision === 'reject') {
    await postRejected(updated, cfg).catch(() => undefined);
    return { ok: true, record: updated, message: 'Rejected. Nothing was created in ClickUp.' };
  }
  return { ok: true, record: updated, message: 'Approved. ClickUp tickets are being created.' };
}

/** Approve and publish in one go — used by the web UI's button and the CLI. */
export async function approveAndPublish(
  id: string,
  by = 'web',
  cfg: Config = getConfig(),
  store: Store = getStore(),
): Promise<{ ok: boolean; message: string; record?: MeetingRecord }> {
  const decision = await applyDecision(id, 'approve', by, cfg, store);
  if (!decision.ok || !decision.record) return decision;
  if (decision.record.stage === 'published') return decision;

  const result: TickResult = {
    scanned: 0,
    dispatched: [],
    collected: [],
    drafted: [],
    posted: [],
    published: [],
    errors: [],
  };
  await publishApproved(cfg, store, result);

  const final = await store.get(id);
  if (result.errors.length) {
    return { ok: false, message: result.errors[0]!.message, record: final ?? undefined };
  }
  return {
    ok: true,
    message: `Created ${final?.published?.length ?? 0} ClickUp items.`,
    record: final ?? undefined,
  };
}
