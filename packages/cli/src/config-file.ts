import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { CONFIG_DIR, CONFIG_PATH } from '@meeting-prd/core';

export type StoredConfig = Record<string, string>;

export function readStored(): StoredConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as StoredConfig;
  } catch {
    return {};
  }
}

/**
 * Written 0600 — the file holds five live API credentials, so it must not be
 * group- or world-readable even on a single-user machine.
 */
export function writeStored(config: StoredConfig): string {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
  return CONFIG_PATH;
}

export function mergeStored(patch: StoredConfig): string {
  const next = { ...readStored() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === '') delete next[k];
    else next[k] = v;
  }
  return writeStored(next);
}

/** Apply the stored file to process.env so core picks it up in this process. */
export function applyStoredToEnv(): void {
  for (const [k, v] of Object.entries(readStored())) {
    if (!process.env[k]) process.env[k] = v;
  }
}

export const ENV_KEYS = [
  'GROQ_API_KEY',
  'GROQ_MODEL',
  'GROQ_MAX_TOKENS',
  'GROQ_TPM_LIMIT',
  'VEXA_API_KEY',
  'VEXA_BASE_URL',
  'VEXA_BOT_NAME',
  'VEXA_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_CALENDAR_ID',
  'SLACK_WEBHOOK_URL',
  'CLICKUP_API_TOKEN',
  'CLICKUP_TEAM_ID',
  'CLICKUP_LIST_ID',
  'APP_BASE_URL',
  'APPROVAL_SECRET',
  'CRON_SECRET',
  'LOOKAHEAD_MINUTES',
  'IDLE_TIMEOUT_MINUTES',
  'AUTO_APPROVE',
] as const;
