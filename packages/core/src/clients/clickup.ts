import type { Prd, PublishedTicket } from '../types.js';
import { getConfig, type Config } from '../config.js';
import { log } from '../logger.js';

const API = 'https://api.clickup.com/api/v2';

/** ClickUp priority ids: 1 Urgent, 2 High, 3 Normal, 4 Low. */
const PRIORITY: Record<Prd['features'][number]['priority'], number> = {
  P0: 1,
  P1: 2,
  P2: 3,
  P3: 4,
};

export interface ClickUpTask {
  id: string;
  name: string;
  url: string;
}

interface Named {
  id: string;
  name: string;
}

/**
 * ClickUp's free tier allows 100 requests/minute. A PRD with many stories can
 * approach that, so serialise writes with a small gap and retry on 429.
 */
let lastCall = 0;
const MIN_GAP_MS = 120;

async function throttle() {
  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

async function api<T>(
  path: string,
  init: RequestInit = {},
  cfg: Config = getConfig(),
  attempt = 0,
): Promise<T> {
  if (!cfg.clickupApiToken) throw new Error('CLICKUP_API_TOKEN is not set');
  await throttle();

  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: cfg.clickupApiToken, // ClickUp uses a bare token, not Bearer
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 429 && attempt < 4) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '5');
    log.warn(`clickup: rate limited, retrying in ${retryAfter}s`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return api<T>(path, init, cfg, attempt + 1);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ClickUp ${init.method ?? 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

// --- Discovery: turn a workspace id into a usable list id -----------------

export interface DiscoveredList {
  spaceId: string;
  spaceName: string;
  folderName: string | null;
  listId: string;
  listName: string;
}

export async function discoverLists(cfg: Config = getConfig()): Promise<DiscoveredList[]> {
  let teamId = cfg.clickupTeamId;
  if (!teamId) {
    const teams = await api<{ teams: Named[] }>('/team', {}, cfg);
    teamId = teams.teams[0]?.id ?? '';
    if (!teamId) throw new Error('No ClickUp workspace found for this token');
  }

  const { spaces } = await api<{ spaces: Named[] }>(`/team/${teamId}/space?archived=false`, {}, cfg);
  const out: DiscoveredList[] = [];

  for (const space of spaces) {
    // Lists that live directly in a space, with no folder.
    const folderless = await api<{ lists: Named[] }>(`/space/${space.id}/list?archived=false`, {}, cfg);
    for (const list of folderless.lists) {
      out.push({
        spaceId: space.id,
        spaceName: space.name,
        folderName: null,
        listId: list.id,
        listName: list.name,
      });
    }

    const { folders } = await api<{ folders: (Named & { lists?: Named[] })[] }>(
      `/space/${space.id}/folder?archived=false`,
      {},
      cfg,
    );
    for (const folder of folders) {
      for (const list of folder.lists ?? []) {
        out.push({
          spaceId: space.id,
          spaceName: space.name,
          folderName: folder.name,
          listId: list.id,
          listName: list.name,
        });
      }
    }
  }
  return out;
}

export async function verifyList(listId: string, cfg: Config = getConfig()): Promise<Named> {
  return api<Named>(`/list/${listId}`, {}, cfg);
}

// --- Writing --------------------------------------------------------------

interface CreateTaskInput {
  listId: string;
  name: string;
  markdownDescription: string;
  priority?: number;
  tags?: string[];
  parent?: string;
  timeEstimateMs?: number;
}

async function createTask(input: CreateTaskInput, cfg: Config): Promise<ClickUpTask> {
  const body: Record<string, unknown> = {
    name: input.name.slice(0, 250),
    markdown_description: input.markdownDescription,
  };
  if (input.priority) body.priority = input.priority;
  if (input.tags?.length) body.tags = input.tags;
  if (input.parent) body.parent = input.parent;
  if (input.timeEstimateMs) body.time_estimate = input.timeEstimateMs;

  return api<ClickUpTask>(
    `/list/${input.listId}/task`,
    { method: 'POST', body: JSON.stringify(body) },
    cfg,
  );
}

async function addChecklist(taskId: string, name: string, items: string[], cfg: Config) {
  const { checklist } = await api<{ checklist: { id: string } }>(
    `/task/${taskId}/checklist`,
    { method: 'POST', body: JSON.stringify({ name }) },
    cfg,
  );
  for (const item of items) {
    await api(
      `/checklist/${checklist.id}/checklist_item`,
      { method: 'POST', body: JSON.stringify({ name: item.slice(0, 250) }) },
      cfg,
    );
  }
}

function featureBody(f: Prd['features'][number], prd: Prd, sourceUrl?: string): string {
  const lines = [
    `## Description`,
    f.description,
    '',
    `## Rationale`,
    f.rationale,
    '',
    `## Acceptance criteria`,
    ...f.acceptance_criteria.map((c) => `- [ ] ${c}`),
    '',
    `## Context`,
    `**Problem:** ${prd.problem_statement}`,
    '',
    `**Success metrics:**`,
    ...prd.success_metrics.map((m) => `- ${m}`),
  ];
  if (sourceUrl) lines.push('', `---`, `_Generated from a meeting transcript · [review PRD](${sourceUrl})_`);
  return lines.join('\n');
}

function storyBody(s: Prd['features'][number]['stories'][number]): string {
  return [
    `**As a** ${s.as_a}`,
    `**I want** ${s.i_want}`,
    `**So that** ${s.so_that}`,
    '',
    `## Acceptance criteria`,
    ...s.acceptance_criteria.map((c) => `- [ ] ${c}`),
    '',
    `_Estimate: ${s.estimate_points} points_`,
  ].join('\n');
}

export interface PublishOptions {
  listId?: string;
  reviewUrl?: string;
  /** Create task-level children under each story. Falls back to a checklist. */
  nestTasks?: boolean;
}

/**
 * Creates the Feature -> Story -> Task hierarchy.
 *
 * Feature becomes a top-level task, each Story a subtask of it. Tasks are
 * created as subtasks of the story where the workspace permits nested subtasks;
 * ClickUp rejects that on some plans, so the first failure switches the whole
 * run to checklist mode rather than retrying per story.
 */
export async function publishPrd(
  prd: Prd,
  opts: PublishOptions = {},
  cfg: Config = getConfig(),
): Promise<PublishedTicket[]> {
  const listId = opts.listId ?? cfg.clickupListId;
  if (!listId) throw new Error('CLICKUP_LIST_ID is not set — run: meeting-prd clickup:discover');

  const created: PublishedTicket[] = [];
  let nestTasks = opts.nestTasks ?? true;

  for (const feature of prd.features) {
    const featureTask = await createTask(
      {
        listId,
        name: `[Feature] ${feature.name}`,
        markdownDescription: featureBody(feature, prd, opts.reviewUrl),
        priority: PRIORITY[feature.priority] ?? 3,
        tags: ['prd', 'feature', feature.priority.toLowerCase()],
      },
      cfg,
    );
    created.push({
      kind: 'feature',
      clickupId: featureTask.id,
      url: featureTask.url,
      title: feature.name,
    });
    log.info(`clickup: feature "${feature.name}" -> ${featureTask.id}`);

    for (const story of feature.stories) {
      const storyTask = await createTask(
        {
          listId,
          name: `[Story] ${story.title}`,
          markdownDescription: storyBody(story),
          parent: featureTask.id,
          tags: ['prd', 'story'],
        },
        cfg,
      );
      created.push({
        kind: 'story',
        clickupId: storyTask.id,
        url: storyTask.url,
        title: story.title,
        parentId: featureTask.id,
      });

      if (!story.tasks.length) continue;

      if (nestTasks) {
        try {
          for (const task of story.tasks) {
            const child = await createTask(
              {
                listId,
                name: task.title,
                markdownDescription: task.description,
                parent: storyTask.id,
                tags: ['prd', ...task.labels].slice(0, 10),
                timeEstimateMs: Math.round((task.estimate_hours || 0) * 3_600_000) || undefined,
              },
              cfg,
            );
            created.push({
              kind: 'task',
              clickupId: child.id,
              url: child.url,
              title: task.title,
              parentId: storyTask.id,
            });
          }
          continue;
        } catch (err) {
          log.warn(`clickup: nested subtasks unavailable, switching to checklists — ${err}`);
          nestTasks = false;
        }
      }

      await addChecklist(
        storyTask.id,
        'Tasks',
        story.tasks.map((t) => `${t.title} (${t.estimate_hours}h)`),
        cfg,
      );
    }
  }

  return created;
}
