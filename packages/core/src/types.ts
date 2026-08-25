/** Domain types for the Calendar -> Vexa -> Groq -> Slack -> ClickUp pipeline. */

export type MeetingStage =
  | 'scheduled' // discovered on the calendar, bot not yet sent
  | 'dispatched' // Vexa bot requested
  | 'recording' // transcript lines are arriving
  | 'transcribed' // meeting ended, transcript frozen
  | 'drafted' // Groq produced a PRD
  | 'awaiting_approval' // posted to Slack
  | 'approved'
  | 'rejected'
  | 'published' // ClickUp tickets created
  | 'failed';

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  startsAt: string; // ISO 8601
  endsAt: string; // ISO 8601
  meetUrl?: string;
  meetCode?: string; // "abc-defg-hij" — Vexa's native_meeting_id
  attendees: string[];
  organizer?: string;
}

export interface TranscriptSegment {
  speaker: string;
  text: string;
  /** ISO timestamp, or seconds-offset rendered as a string, depending on Vexa build. */
  time?: string;
}

export interface PrdTask {
  title: string;
  description: string;
  estimate_hours: number;
  labels: string[];
}

export interface PrdStory {
  title: string;
  as_a: string;
  i_want: string;
  so_that: string;
  acceptance_criteria: string[];
  estimate_points: number;
  tasks: PrdTask[];
}

export interface PrdFeature {
  name: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  rationale: string;
  acceptance_criteria: string[];
  stories: PrdStory[];
}

export interface Prd {
  title: string;
  summary: string;
  problem_statement: string;
  goals: string[];
  non_goals: string[];
  stakeholders: string[];
  success_metrics: string[];
  features: PrdFeature[];
  risks: string[];
  open_questions: string[];
  decisions: string[];
  /** Free-form, e.g. "2 sprints" — the model is told not to invent hard dates. */
  timeline: string;
}

export interface PublishedTicket {
  kind: 'feature' | 'story' | 'task';
  clickupId: string;
  url: string;
  title: string;
  parentId?: string;
}

export interface MeetingRecord {
  /** Stable id: the Google Calendar event id. */
  id: string;
  stage: MeetingStage;
  event: CalendarEvent;

  botDispatchedAt?: string;
  transcript?: TranscriptSegment[];
  transcriptUpdatedAt?: string;
  lastTranscriptLength?: number;

  prd?: Prd;
  prdGeneratedAt?: string;
  prdModel?: string;

  slackPostedAt?: string;
  decidedAt?: string;
  decidedBy?: string;

  published?: PublishedTicket[];
  publishedAt?: string;

  error?: string;
  updatedAt: string;
}

export interface TickResult {
  scanned: number;
  dispatched: string[];
  collected: string[];
  drafted: string[];
  posted: string[];
  published: string[];
  errors: { id: string; message: string }[];
}
