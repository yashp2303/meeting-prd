import type { CalendarEvent } from '../types.js';
import { getConfig, type Config } from '../config.js';
import { log } from '../logger.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

interface RawEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: { email?: string; responseStatus?: string }[];
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function accessToken(cfg: Config): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  if (!cfg.googleClientId || !cfg.googleClientSecret || !cfg.googleRefreshToken) {
    throw new Error('Google Calendar is not configured. Run: meeting-prd google:auth');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      refresh_token: cfg.googleRefreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Google token refresh failed (${res.status}). The refresh token may have been revoked — ` +
        `re-run \`meeting-prd google:auth\`. Detail: ${body.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return tokenCache.token;
}

/** Google Meet codes look like `abc-defg-hij`; that is Vexa's native_meeting_id. */
export function extractMeetCode(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  return match?.[1]?.toLowerCase();
}

function findMeetUrl(raw: RawEvent): string | undefined {
  if (raw.hangoutLink) return raw.hangoutLink;

  const entry = raw.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === 'video' && e.uri?.includes('meet.google.com'),
  );
  if (entry?.uri) return entry.uri;

  // Some invites only carry the link in free text.
  for (const field of [raw.location, raw.description]) {
    const found = field?.match(/https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i);
    if (found) return found[0];
  }
  return undefined;
}

function normalise(raw: RawEvent): CalendarEvent | null {
  const startsAt = raw.start?.dateTime ?? raw.start?.date;
  const endsAt = raw.end?.dateTime ?? raw.end?.date;
  if (!startsAt || !endsAt) return null; // all-day or malformed

  const meetUrl = findMeetUrl(raw);
  return {
    id: raw.id,
    title: raw.summary ?? '(untitled meeting)',
    description: raw.description,
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    meetUrl,
    meetCode: extractMeetCode(meetUrl),
    organizer: raw.organizer?.email,
    attendees: (raw.attendees ?? [])
      .map((a) => a.email)
      .filter((e): e is string => Boolean(e)),
  };
}

export interface ListOptions {
  /** How far ahead to look. */
  windowMinutes?: number;
  /** Drop events with no Google Meet link. Default true. */
  requireMeetLink?: boolean;
  from?: Date;
}

export async function listUpcomingMeetings(
  opts: ListOptions = {},
  cfg: Config = getConfig(),
): Promise<CalendarEvent[]> {
  const { windowMinutes = 60, requireMeetLink = true, from = new Date() } = opts;
  const token = await accessToken(cfg);

  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: new Date(from.getTime() + windowMinutes * 60_000).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });

  const url = `${CALENDAR_API}/calendars/${encodeURIComponent(cfg.googleCalendarId)}/events?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!res.ok) {
    throw new Error(`Google Calendar list failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const json = (await res.json()) as { items?: RawEvent[] };
  const events = (json.items ?? [])
    .filter((e) => e.status !== 'cancelled')
    .map(normalise)
    .filter((e): e is CalendarEvent => e !== null)
    .filter((e) => (requireMeetLink ? Boolean(e.meetCode) : true));

  log.debug(`calendar: ${events.length} meeting(s) in the next ${windowMinutes}m`);
  return events;
}

// --- One-time OAuth helpers, used by `meeting-prd google:auth` -------------

export function buildAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token even on re-auth
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<{ refresh_token?: string; access_token: string }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Code exchange failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ refresh_token?: string; access_token: string }>;
}
