import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  groqApiKey: string;
  groqModel: string;

  vexaApiKey: string;
  vexaBaseUrl: string;
  vexaBotName: string;
  vexaLanguage: string;

  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string;
  googleCalendarId: string;

  slackWebhookUrl: string;

  clickupApiToken: string;
  clickupTeamId: string;
  clickupListId: string;

  appBaseUrl: string;
  approvalSecret: string;
  cronSecret: string;

  lookaheadMinutes: number;
  idleTimeoutMinutes: number;
  autoApprove: boolean;

  upstashUrl: string;
  upstashToken: string;
}

export const CONFIG_DIR = join(homedir(), '.meeting-prd');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/**
 * Config resolves from three layers, later winning:
 *   1. ~/.meeting-prd/config.json  (written by `meeting-prd init`)
 *   2. process.env
 * On Vercel only layer 2 exists, which is intentional — secrets stay in the
 * platform's env store and never touch the repo or the filesystem.
 */
function fileLayer(): Record<string, string> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

let cached: Config | null = null;

export function loadConfig(overrides: Partial<Record<string, string>> = {}): Config {
  const file = fileLayer();
  const pick = (key: string, fallback = ''): string =>
    overrides[key] ?? process.env[key] ?? file[key] ?? fallback;

  return {
    groqApiKey: pick('GROQ_API_KEY'),
    groqModel: pick('GROQ_MODEL', 'openai/gpt-oss-120b'),

    vexaApiKey: pick('VEXA_API_KEY'),
    vexaBaseUrl: pick('VEXA_BASE_URL', 'https://api.cloud.vexa.ai').replace(/\/+$/, ''),
    vexaBotName: pick('VEXA_BOT_NAME', 'PRD Bot'),
    vexaLanguage: pick('VEXA_LANGUAGE', 'en'),

    googleClientId: pick('GOOGLE_CLIENT_ID'),
    googleClientSecret: pick('GOOGLE_CLIENT_SECRET'),
    googleRefreshToken: pick('GOOGLE_REFRESH_TOKEN'),
    googleCalendarId: pick('GOOGLE_CALENDAR_ID', 'primary'),

    slackWebhookUrl: pick('SLACK_WEBHOOK_URL'),

    clickupApiToken: pick('CLICKUP_API_TOKEN'),
    clickupTeamId: pick('CLICKUP_TEAM_ID'),
    clickupListId: pick('CLICKUP_LIST_ID'),

    appBaseUrl: pick('APP_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
    approvalSecret: pick('APPROVAL_SECRET'),
    cronSecret: pick('CRON_SECRET'),

    lookaheadMinutes: Number(pick('LOOKAHEAD_MINUTES', '10')) || 10,
    idleTimeoutMinutes: Number(pick('IDLE_TIMEOUT_MINUTES', '5')) || 5,
    autoApprove: pick('AUTO_APPROVE', '0') === '1',

    upstashUrl: pick('UPSTASH_REDIS_REST_URL'),
    upstashToken: pick('UPSTASH_REDIS_REST_TOKEN'),
  };
}

export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}

export interface CheckResult {
  key: string;
  label: string;
  ok: boolean;
  required: boolean;
  hint: string;
}

/** Powers `meeting-prd doctor` and the /api/health endpoint. */
export function checkConfig(cfg: Config = getConfig()): CheckResult[] {
  const check = (
    key: string,
    label: string,
    value: string,
    required: boolean,
    hint: string,
  ): CheckResult => ({ key, label, ok: value.trim().length > 0, required, hint });

  return [
    check('GROQ_API_KEY', 'Groq API key', cfg.groqApiKey, true, 'console.groq.com/keys'),
    check('VEXA_API_KEY', 'Vexa API key', cfg.vexaApiKey, true, 'vexa.ai — or self-host'),
    check('GOOGLE_CLIENT_ID', 'Google client id', cfg.googleClientId, true, 'console.cloud.google.com'),
    check('GOOGLE_CLIENT_SECRET', 'Google client secret', cfg.googleClientSecret, true, 'same OAuth client'),
    check('GOOGLE_REFRESH_TOKEN', 'Google refresh token', cfg.googleRefreshToken, true, 'run: meeting-prd google:auth'),
    check('SLACK_WEBHOOK_URL', 'Slack webhook', cfg.slackWebhookUrl, true, 'api.slack.com/messaging/webhooks'),
    check('CLICKUP_API_TOKEN', 'ClickUp token', cfg.clickupApiToken, true, 'ClickUp > Settings > Apps'),
    check('CLICKUP_LIST_ID', 'ClickUp list id', cfg.clickupListId, true, 'run: meeting-prd clickup:discover'),
    check('APPROVAL_SECRET', 'Approval HMAC secret', cfg.approvalSecret, true, 'openssl rand -hex 32'),
    check('CRON_SECRET', 'Cron bearer token', cfg.cronSecret, false, 'openssl rand -hex 32'),
    check('APP_BASE_URL', 'Public app URL', cfg.appBaseUrl, false, 'your *.vercel.app origin'),
    check('CLICKUP_TEAM_ID', 'ClickUp team id', cfg.clickupTeamId, false, 'from your ClickUp URL'),
  ];
}
