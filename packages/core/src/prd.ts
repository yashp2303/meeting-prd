import type { CalendarEvent, Prd, TranscriptSegment } from './types.js';
import { complete, extractJson } from './clients/groq.js';
import { transcriptToText } from './clients/vexa.js';
import { getConfig, type Config } from './config.js';
import { log } from './logger.js';

/** JSON Schema handed to Groq so the model is constrained, not just asked nicely. */
export const PRD_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'summary',
    'problem_statement',
    'goals',
    'non_goals',
    'stakeholders',
    'success_metrics',
    'features',
    'risks',
    'open_questions',
    'decisions',
    'timeline',
  ],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    problem_statement: { type: 'string' },
    goals: { type: 'array', items: { type: 'string' } },
    non_goals: { type: 'array', items: { type: 'string' } },
    stakeholders: { type: 'array', items: { type: 'string' } },
    success_metrics: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    timeline: { type: 'string' },
    features: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'priority', 'rationale', 'acceptance_criteria', 'stories'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          rationale: { type: 'string' },
          acceptance_criteria: { type: 'array', items: { type: 'string' } },
          stories: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'title',
                'as_a',
                'i_want',
                'so_that',
                'acceptance_criteria',
                'estimate_points',
                'tasks',
              ],
              properties: {
                title: { type: 'string' },
                as_a: { type: 'string' },
                i_want: { type: 'string' },
                so_that: { type: 'string' },
                acceptance_criteria: { type: 'array', items: { type: 'string' } },
                estimate_points: { type: 'number' },
                tasks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['title', 'description', 'estimate_hours', 'labels'],
                    properties: {
                      title: { type: 'string' },
                      description: { type: 'string' },
                      estimate_hours: { type: 'number' },
                      labels: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a senior product manager writing a Product Requirements Document from a raw meeting transcript.

Rules:
- Ground every statement in the transcript. Do not invent requirements, names, dates, or metrics that were not discussed.
- When the transcript is ambiguous or something was left undecided, put it in open_questions rather than guessing.
- decisions must contain only things the participants explicitly agreed to.
- Break work down properly: each feature gets user stories, each story gets concrete engineering tasks.
- estimate_points uses a Fibonacci scale (1, 2, 3, 5, 8, 13). estimate_hours is a realistic number for one engineer.
- Priority: P0 blocks launch, P1 is important, P2 is nice to have, P3 is a backlog idea.
- Acceptance criteria must be testable and specific — a QA engineer should be able to verify each one.
- timeline is a rough relative estimate such as "2 sprints". Never invent calendar dates.
- If the transcript is too thin to support a PRD, still return valid JSON: use a short summary, an empty features array, and explain what is missing in open_questions.

Return only the JSON object.`;

function buildUserPrompt(event: CalendarEvent, transcript: TranscriptSegment[]): string {
  const text = transcriptToText(transcript);
  return [
    `# Meeting`,
    `Title: ${event.title}`,
    `When: ${event.startsAt} to ${event.endsAt}`,
    event.organizer ? `Organizer: ${event.organizer}` : '',
    event.attendees.length ? `Attendees: ${event.attendees.join(', ')}` : '',
    event.description ? `\nCalendar description:\n${event.description}` : '',
    '',
    `# Transcript`,
    text || '(the transcript is empty)',
    '',
    `Write the PRD as JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Coerce a loosely-shaped model response into a valid Prd. */
export function normalisePrd(raw: unknown, fallbackTitle: string): Prd {
  const o = (raw ?? {}) as Record<string, unknown>;
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  const str = (v: unknown, fallback = ''): string =>
    typeof v === 'string' && v.trim() ? v.trim() : fallback;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  const features = (Array.isArray(o.features) ? o.features : []).map((f) => {
    const fo = (f ?? {}) as Record<string, unknown>;
    const priority = str(fo.priority, 'P2').toUpperCase();
    return {
      name: str(fo.name, 'Untitled feature'),
      description: str(fo.description),
      priority: (['P0', 'P1', 'P2', 'P3'].includes(priority) ? priority : 'P2') as Prd['features'][number]['priority'],
      rationale: str(fo.rationale),
      acceptance_criteria: strArr(fo.acceptance_criteria),
      stories: (Array.isArray(fo.stories) ? fo.stories : []).map((s) => {
        const so = (s ?? {}) as Record<string, unknown>;
        return {
          title: str(so.title, 'Untitled story'),
          as_a: str(so.as_a, 'user'),
          i_want: str(so.i_want),
          so_that: str(so.so_that),
          acceptance_criteria: strArr(so.acceptance_criteria),
          estimate_points: num(so.estimate_points, 3),
          tasks: (Array.isArray(so.tasks) ? so.tasks : []).map((t) => {
            const to = (t ?? {}) as Record<string, unknown>;
            return {
              title: str(to.title, 'Untitled task'),
              description: str(to.description),
              estimate_hours: num(to.estimate_hours, 4),
              labels: strArr(to.labels),
            };
          }),
        };
      }),
    };
  });

  return {
    title: str(o.title, fallbackTitle),
    summary: str(o.summary),
    problem_statement: str(o.problem_statement),
    goals: strArr(o.goals),
    non_goals: strArr(o.non_goals),
    stakeholders: strArr(o.stakeholders),
    success_metrics: strArr(o.success_metrics),
    features,
    risks: strArr(o.risks),
    open_questions: strArr(o.open_questions),
    decisions: strArr(o.decisions),
    timeline: str(o.timeline, 'Not estimated'),
  };
}

/** Rough guard so a very long transcript cannot blow the context window. */
function trimTranscript(segments: TranscriptSegment[], maxChars = 320_000): TranscriptSegment[] {
  let total = 0;
  for (const s of segments) total += s.speaker.length + s.text.length + 2;
  if (total <= maxChars) return segments;

  log.warn(`transcript is ${total} chars — keeping the last ${maxChars}`);
  const kept: TranscriptSegment[] = [];
  let running = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]!;
    running += s.speaker.length + s.text.length + 2;
    if (running > maxChars) break;
    kept.unshift(s);
  }
  return kept;
}

export interface GenerateResult {
  prd: Prd;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function generatePrd(
  event: CalendarEvent,
  transcript: TranscriptSegment[],
  cfg: Config = getConfig(),
): Promise<GenerateResult> {
  const trimmed = trimTranscript(transcript);
  log.info(`groq: generating PRD for "${event.title}" from ${trimmed.length} segments`);

  const result = await complete(
    {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(event, trimmed) },
      ],
      jsonSchema: { name: 'prd', schema: PRD_SCHEMA },
      temperature: 0.2,
      maxTokens: 16000,
    },
    cfg,
  );

  const prd = normalisePrd(extractJson(result.text), event.title);
  log.info(
    `groq: PRD "${prd.title}" — ${prd.features.length} features, ` +
      `${prd.features.reduce((n, f) => n + f.stories.length, 0)} stories`,
  );
  return { prd, model: result.model, usage: result.usage };
}

/** Markdown rendering, used by the review UI and `meeting-prd show`. */
export function prdToMarkdown(prd: Prd): string {
  const out: string[] = [`# ${prd.title}`, '', prd.summary, ''];
  const list = (heading: string, items: string[]) => {
    if (!items.length) return;
    out.push(`## ${heading}`, ...items.map((i) => `- ${i}`), '');
  };

  out.push('## Problem', prd.problem_statement, '');
  list('Goals', prd.goals);
  list('Non-goals', prd.non_goals);
  list('Stakeholders', prd.stakeholders);
  list('Success metrics', prd.success_metrics);
  list('Decisions', prd.decisions);

  out.push('## Features', '');
  for (const f of prd.features) {
    out.push(`### ${f.name} \`${f.priority}\``, '', f.description, '', `_${f.rationale}_`, '');
    if (f.acceptance_criteria.length) {
      out.push('**Acceptance criteria**', ...f.acceptance_criteria.map((c) => `- [ ] ${c}`), '');
    }
    for (const s of f.stories) {
      out.push(
        `#### ${s.title} (${s.estimate_points} pts)`,
        '',
        `As a **${s.as_a}**, I want **${s.i_want}**, so that **${s.so_that}**.`,
        '',
      );
      if (s.acceptance_criteria.length) {
        out.push(...s.acceptance_criteria.map((c) => `- [ ] ${c}`), '');
      }
      if (s.tasks.length) {
        out.push('**Tasks**', ...s.tasks.map((t) => `- ${t.title} — ${t.estimate_hours}h`), '');
      }
    }
  }

  list('Risks', prd.risks);
  list('Open questions', prd.open_questions);
  out.push(`**Timeline:** ${prd.timeline}`);
  return out.join('\n');
}
