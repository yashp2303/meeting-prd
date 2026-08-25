import {
  loadConfig,
  resetConfigCache,
  checkConfig,
  getStore,
  tick,
  scan,
  applyDecision,
  approveAndPublish,
  prdToMarkdown,
  generateSecret,
  groq,
  vexa,
  clickup,
  calendar,
  type Config,
} from '@meeting-prd/core';

import { ask, askSecret, confirm, choose, say, ok, fail, warn, info, heading, table, spin, c, closePrompts } from './ui.js';
import { mergeStored, readStored, applyStoredToEnv, ENV_KEYS } from './config-file.js';
import { runGoogleAuth, printGoogleSetupHelp } from './google-auth.js';

const VERSION = '0.1.1';

function cfg(): Config {
  resetConfigCache();
  return loadConfig();
}

// ---------------------------------------------------------------------------
// init — the wizard a fresh `brew install` lands in
// ---------------------------------------------------------------------------

async function cmdInit() {
  const existing = readStored();
  const isReconfigure = Object.keys(existing).length > 0;

  say('');
  say(c.bold('  meeting-prd setup'));
  say(c.grey('  Calendar → Vexa → Meet → Groq → Slack → ClickUp'));
  say('');
  if (isReconfigure) {
    info(`Existing config found. Press Enter at any prompt to keep the current value.`);
  } else {
    info(`Nothing is stored yet. Credentials are saved to ~/.meeting-prd/config.json (chmod 600).`);
  }
  say(c.grey('  Each credential is verified against its live API before it is saved.'));

  const patch: Record<string, string> = {};

  // --- 1. Groq -------------------------------------------------------------
  heading('1/6  Groq — writes the PRD');
  say(c.grey('  Get a key at console.groq.com/keys'));
  let groqKey = '';
  while (true) {
    groqKey = await askSecret('Groq API key', existing.GROQ_API_KEY ?? '');
    if (!groqKey) {
      fail('A Groq key is required.');
      continue;
    }
    try {
      const models = await spin('verifying key…', () =>
        groq.listModels({ ...cfg(), groqApiKey: groqKey }),
      );
      ok(`Key works — ${models.length} models available.`);

      const preferred = ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'].filter((m) =>
        models.includes(m),
      );
      const options = (preferred.length ? preferred : models.slice(0, 6)).map((m) => ({
        label: m,
        value: m,
        hint: m === 'openai/gpt-oss-120b' ? '(recommended — best at long structured JSON)' : '',
      }));
      patch.GROQ_MODEL = await choose('Which model should write PRDs?', options);
      patch.GROQ_API_KEY = groqKey;
      break;
    } catch (err) {
      fail(`Groq rejected that key: ${err instanceof Error ? err.message : err}`);
      if (!(await confirm('Try again?'))) process.exit(1);
    }
  }

  // --- 2. Vexa -------------------------------------------------------------
  heading('2/6  Vexa — puts a bot in the Meet call');
  say(c.grey('  Hosted key: vexa.ai   ·   Self-hosted: http://localhost:18056'));
  const vexaBase = await ask('Vexa base URL', existing.VEXA_BASE_URL ?? 'https://api.cloud.vexa.ai');
  while (true) {
    const key = await askSecret('Vexa API key', existing.VEXA_API_KEY ?? '');
    if (!key) {
      fail('A Vexa key is required — without it there is no transcript.');
      continue;
    }
    const probe = await spin('verifying key…', () =>
      vexa.botStatus({ ...cfg(), vexaApiKey: key, vexaBaseUrl: vexaBase.replace(/\/+$/, '') }),
    );
    if (probe.ok) {
      ok('Vexa reachable and the key is accepted.');
      patch.VEXA_API_KEY = key;
      patch.VEXA_BASE_URL = vexaBase.replace(/\/+$/, '');
      patch.VEXA_BOT_NAME = await ask('Bot display name in the call', existing.VEXA_BOT_NAME ?? 'PRD Bot');
      break;
    }
    fail(`Vexa said: ${probe.error}`);
    if (!(await confirm('Try again?'))) {
      warn('Skipping — the pipeline will not be able to record meetings.');
      break;
    }
  }

  // --- 3. Google Calendar --------------------------------------------------
  heading('3/6  Google Calendar — finds the meetings');
  if (existing.GOOGLE_REFRESH_TOKEN && !(await confirm('Calendar is already connected. Reconnect?', false))) {
    ok('Keeping the existing Google connection.');
  } else {
    printGoogleSetupHelp();
    const clientId = await ask('Google client ID', existing.GOOGLE_CLIENT_ID ?? '');
    const clientSecret = await askSecret('Google client secret', existing.GOOGLE_CLIENT_SECRET ?? '');

    if (clientId && clientSecret) {
      try {
        const { refreshToken } = await runGoogleAuth(clientId, clientSecret);
        patch.GOOGLE_CLIENT_ID = clientId;
        patch.GOOGLE_CLIENT_SECRET = clientSecret;
        patch.GOOGLE_REFRESH_TOKEN = refreshToken;
        ok('Google Calendar connected.');

        const which = await ask('Calendar ID to watch', existing.GOOGLE_CALENDAR_ID ?? 'primary');
        patch.GOOGLE_CALENDAR_ID = which;

        const events = await spin('reading your calendar…', () =>
          calendar.listUpcomingMeetings(
            { windowMinutes: 60 * 24 * 7, requireMeetLink: true },
            {
              ...cfg(),
              googleClientId: clientId,
              googleClientSecret: clientSecret,
              googleRefreshToken: refreshToken,
              googleCalendarId: which,
            },
          ),
        );
        ok(`Found ${events.length} meeting(s) with a Google Meet link in the next 7 days.`);
        for (const e of events.slice(0, 5)) {
          say(c.grey(`     · ${new Date(e.startsAt).toLocaleString()}  ${e.title}`));
        }
      } catch (err) {
        fail(`Google auth failed: ${err instanceof Error ? err.message : err}`);
        warn('You can retry later with: meeting-prd google:auth');
      }
    } else {
      warn('Skipped — run `meeting-prd google:auth` when you have an OAuth client.');
    }
  }

  // --- 4. Slack ------------------------------------------------------------
  heading('4/6  Slack — where approvals are requested');
  say(c.grey('  An incoming webhook is enough. No Slack app or signing secret needed.'));
  const hook = await askSecret('Slack webhook URL', existing.SLACK_WEBHOOK_URL ?? '');
  if (hook) {
    patch.SLACK_WEBHOOK_URL = hook;
    if (await confirm('Send a test message to confirm it works?')) {
      try {
        const res = await spin('posting…', () =>
          fetch(hook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: '✅ meeting-prd connected — approval requests will arrive in this channel.',
            }),
          }),
        );
        if (res.ok) ok('Slack received it. Check the channel.');
        else fail(`Slack returned ${res.status}: ${await res.text()}`);
      } catch (err) {
        fail(`Could not reach Slack: ${err}`);
      }
    }
  } else {
    warn('Skipped — PRDs will need approving from the web dashboard instead.');
  }

  // --- 5. ClickUp ----------------------------------------------------------
  heading('5/6  ClickUp — where tickets are created');
  say(c.grey('  Personal token: ClickUp → Settings → Apps → API Token (starts pk_)'));
  const cuToken = await askSecret('ClickUp API token', existing.CLICKUP_API_TOKEN ?? '');
  if (cuToken) {
    patch.CLICKUP_API_TOKEN = cuToken;
    const teamId = await ask('ClickUp workspace (team) ID', existing.CLICKUP_TEAM_ID ?? '');
    if (teamId) patch.CLICKUP_TEAM_ID = teamId;

    try {
      const lists = await spin('reading your spaces and lists…', () =>
        clickup.discoverLists({ ...cfg(), clickupApiToken: cuToken, clickupTeamId: teamId }),
      );
      if (!lists.length) {
        warn('No lists found in that workspace. Create one in ClickUp, then re-run init.');
      } else {
        ok(`Found ${lists.length} list(s).`);
        patch.CLICKUP_LIST_ID = await choose(
          'Which list should tickets be created in?',
          lists.slice(0, 40).map((l) => ({
            label: `${l.spaceName}${l.folderName ? ` / ${l.folderName}` : ''} / ${c.bold(l.listName)}`,
            value: l.listId,
            hint: l.listId,
          })),
        );
      }
    } catch (err) {
      fail(`ClickUp rejected that token: ${err instanceof Error ? err.message : err}`);
      warn('Run `meeting-prd clickup:discover` later to finish this step.');
    }
  } else {
    warn('Skipped — approved PRDs will have nowhere to go.');
  }

  // --- 6. App + secrets ----------------------------------------------------
  heading('6/6  App URL and signing secrets');
  patch.APP_BASE_URL = await ask(
    'Public URL of your deployed web app',
    existing.APP_BASE_URL ?? 'http://localhost:3000',
  );
  patch.APPROVAL_SECRET = existing.APPROVAL_SECRET || generateSecret();
  patch.CRON_SECRET = existing.CRON_SECRET || generateSecret();
  ok('Signing secrets generated (they are never prompted for).');

  const path = mergeStored(patch);
  applyStoredToEnv();

  say('');
  ok(`Saved to ${c.bold(path)} ${c.grey('(chmod 600)')}`);
  say('');
  await cmdDoctor();

  say('');
  say(c.bold('  Next steps'));
  table([
    ['meeting-prd tick', 'run the pipeline once, now'],
    ['meeting-prd watch', 'run it every 5 minutes locally'],
    ['meeting-prd env --vercel', 'print the env vars for your Vercel project'],
    ['meeting-prd status', 'see tracked meetings'],
  ]);
  say('');
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function cmdDoctor() {
  applyStoredToEnv();
  const config = cfg();
  heading('Configuration');

  const checks = checkConfig(config);
  for (const check of checks) {
    const mark = check.ok ? c.green('✓') : check.required ? c.red('✗') : c.yellow('○');
    const note = check.ok ? '' : c.grey(`  ${check.hint}`);
    say(`  ${mark} ${check.label.padEnd(24)} ${note}`);
  }

  const missing = checks.filter((x) => x.required && !x.ok);
  say('');
  if (missing.length === 0) ok('All required settings are present.');
  else fail(`${missing.length} required setting(s) missing — run: meeting-prd init`);

  heading('Live checks');
  const store = getStore();
  say(`  ${c.green('✓')} store: ${store.kind} (${(await store.list()).length} records)`);

  if (config.groqApiKey) {
    try {
      const models = await groq.listModels(config);
      const has = models.includes(config.groqModel);
      say(
        `  ${has ? c.green('✓') : c.yellow('○')} groq: ${models.length} models` +
          (has ? '' : c.grey(`  "${config.groqModel}" not in the list`)),
      );
    } catch (err) {
      say(`  ${c.red('✗')} groq: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (config.vexaApiKey) {
    const probe = await vexa.botStatus(config);
    say(probe.ok ? `  ${c.green('✓')} vexa: reachable` : `  ${c.red('✗')} vexa: ${probe.error}`);
  }

  if (config.clickupApiToken && config.clickupListId) {
    try {
      const list = await clickup.verifyList(config.clickupListId, config);
      say(`  ${c.green('✓')} clickup: writing to "${list.name}"`);
    } catch (err) {
      say(`  ${c.red('✗')} clickup: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (config.googleRefreshToken) {
    try {
      const events = await calendar.listUpcomingMeetings({ windowMinutes: 60 * 24 }, config);
      say(`  ${c.green('✓')} calendar: ${events.length} Meet event(s) in the next 24h`);
    } catch (err) {
      say(`  ${c.red('✗')} calendar: ${err instanceof Error ? err.message : err}`);
    }
  }
  say('');
}

// ---------------------------------------------------------------------------
// pipeline commands
// ---------------------------------------------------------------------------

async function cmdTick() {
  applyStoredToEnv();
  const result = await spin('running the pipeline…', () => tick(cfg()));

  heading('Tick');
  table([
    ['new meetings found', String(result.scanned)],
    ['bots dispatched', result.dispatched.length ? result.dispatched.join(', ') : '—'],
    ['transcripts updated', result.collected.length ? String(result.collected.length) : '—'],
    ['PRDs drafted', result.drafted.length ? String(result.drafted.length) : '—'],
    ['approvals posted', result.posted.length ? String(result.posted.length) : '—'],
    ['published to ClickUp', result.published.length ? String(result.published.length) : '—'],
  ]);
  if (result.errors.length) {
    say('');
    for (const e of result.errors) fail(`${e.id}: ${e.message}`);
  }
  say('');
}

async function cmdWatch(args: string[]) {
  applyStoredToEnv();
  const minutes = Number(args[0] ?? '5') || 5;
  info(`Ticking every ${minutes} minute(s). Ctrl-C to stop.`);

  const once = async () => {
    try {
      const r = await tick(cfg());
      const parts = [
        r.scanned ? `+${r.scanned} found` : '',
        r.dispatched.length ? `${r.dispatched.length} dispatched` : '',
        r.collected.length ? `${r.collected.length} recording` : '',
        r.drafted.length ? `${r.drafted.length} drafted` : '',
        r.posted.length ? `${r.posted.length} posted` : '',
        r.published.length ? `${r.published.length} published` : '',
      ].filter(Boolean);
      say(
        `${c.grey(new Date().toLocaleTimeString())} ${parts.length ? parts.join(' · ') : c.grey('idle')}`,
      );
      for (const e of r.errors) fail(`  ${e.id}: ${e.message}`);
    } catch (err) {
      fail(String(err));
    }
  };

  await once();
  setInterval(once, minutes * 60_000);
}

async function cmdScan() {
  applyStoredToEnv();
  const added = await spin('reading the calendar…', () => scan(cfg()));
  ok(`${added.length} new meeting(s) registered.`);
  await cmdStatus();
}

async function cmdStatus() {
  applyStoredToEnv();
  const records = await getStore().list();
  heading(`Meetings (${records.length})`);
  if (!records.length) {
    say(c.grey('  Nothing tracked yet. Run: meeting-prd scan'));
    say('');
    return;
  }
  for (const r of records) {
    const stageColor =
      r.stage === 'published' || r.stage === 'approved'
        ? c.green
        : r.stage === 'failed' || r.stage === 'rejected'
          ? c.red
          : r.stage === 'awaiting_approval' || r.stage === 'drafted'
            ? c.yellow
            : c.grey;
    say(`  ${stageColor(r.stage.padEnd(18))} ${r.event.title}`);
    say(
      c.grey(
        `  ${''.padEnd(18)} ${new Date(r.event.startsAt).toLocaleString()}` +
          `${r.transcript?.length ? ` · ${r.transcript.length} segments` : ''}` +
          `${r.prd ? ` · ${r.prd.features.length} features` : ''}` +
          `  ${c.dim(r.id)}`,
      ),
    );
    if (r.error) say(`  ${''.padEnd(18)} ${c.red(r.error)}`);
  }
  say('');
}

async function cmdShow(args: string[]) {
  applyStoredToEnv();
  const id = args[0];
  if (!id) return fail('Usage: meeting-prd show <meeting-id>');
  const record = await getStore().get(id);
  if (!record) return fail(`No meeting with id ${id}`);
  if (!record.prd) return fail(`No PRD yet — stage is ${record.stage}`);
  say('');
  say(prdToMarkdown(record.prd));
  say('');
}

async function cmdDecide(args: string[], decision: 'approve' | 'reject') {
  applyStoredToEnv();
  const id = args[0];
  if (!id) return fail(`Usage: meeting-prd ${decision} <meeting-id>`);

  if (decision === 'reject') {
    const result = await applyDecision(id, 'reject', 'cli', cfg());
    return result.ok ? ok(result.message) : fail(result.message);
  }
  const result = await spin('approving and creating tickets…', () =>
    approveAndPublish(id, 'cli', cfg()),
  );
  if (!result.ok) return fail(result.message);
  ok(result.message);
  for (const t of result.record?.published ?? []) {
    if (t.kind === 'feature') say(c.grey(`     ${t.title} → ${t.url}`));
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function cmdClickUpDiscover() {
  applyStoredToEnv();
  const lists = await spin('reading ClickUp…', () => clickup.discoverLists(cfg()));
  heading(`ClickUp lists (${lists.length})`);
  for (const l of lists) {
    say(`  ${c.bold(l.listId.padEnd(12))} ${l.spaceName}${l.folderName ? ` / ${l.folderName}` : ''} / ${l.listName}`);
  }
  say('');
  if (lists.length && (await confirm('Save one of these as the target list?'))) {
    const picked = await choose(
      'Which list?',
      lists.map((l) => ({ label: `${l.spaceName} / ${l.listName}`, value: l.listId, hint: l.listId })),
    );
    mergeStored({ CLICKUP_LIST_ID: picked });
    ok(`Saved CLICKUP_LIST_ID=${picked}`);
  }
}

async function cmdGoogleAuth() {
  applyStoredToEnv();
  const existing = readStored();
  printGoogleSetupHelp();
  const clientId = await ask('Google client ID', existing.GOOGLE_CLIENT_ID ?? '');
  const clientSecret = await askSecret('Google client secret', existing.GOOGLE_CLIENT_SECRET ?? '');
  if (!clientId || !clientSecret) return fail('Both the client ID and secret are required.');

  const { refreshToken } = await runGoogleAuth(clientId, clientSecret);
  mergeStored({
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_REFRESH_TOKEN: refreshToken,
  });
  ok('Google Calendar connected and saved.');
}

async function cmdModels() {
  applyStoredToEnv();
  const models = await spin('asking Groq…', () => groq.listModels(cfg()));
  heading(`Groq models (${models.length})`);
  for (const m of models) say(`  ${m === cfg().groqModel ? c.green('●') : ' '} ${m}`);
  say('');
}

function cmdEnv(args: string[]) {
  applyStoredToEnv();
  const stored = readStored();
  const forVercel = args.includes('--vercel');

  if (forVercel) {
    heading('Vercel environment variables');
    say(c.grey('  Paste each into Vercel → Project → Settings → Environment Variables,'));
    say(c.grey('  or pipe this straight in with the Vercel CLI:'));
    say('');
    for (const key of ENV_KEYS) {
      const value = stored[key] ?? process.env[key];
      if (value) say(`  vercel env add ${key} production`);
    }
    say('');
    say(c.bold('  Values:'));
  }

  say('');
  for (const key of ENV_KEYS) {
    const value = stored[key] ?? process.env[key];
    if (value) say(`${key}=${value}`);
  }
  say('');
  warn('This output contains live secrets. Do not paste it anywhere public.');
}

function cmdHelp() {
  say('');
  say(c.bold('  meeting-prd') + c.grey(` v${VERSION}`));
  say(c.grey('  Meeting transcript → PRD → ClickUp tickets, with Slack approval in between.'));
  say('');
  say(c.bold('  Setup'));
  table([
    ['init', 'interactive setup — prompts for every credential'],
    ['doctor', 'verify config and reach every API'],
    ['google:auth', 'connect Google Calendar (OAuth)'],
    ['clickup:discover', 'list ClickUp spaces/lists and pick a target'],
    ['models', 'list Groq models'],
  ]);
  say('');
  say(c.bold('  Run'));
  table([
    ['tick', 'one pass of the whole pipeline'],
    ['watch [minutes]', 'tick on a loop (default 5)'],
    ['scan', 'read the calendar only'],
    ['status', 'list tracked meetings'],
    ['show <id>', 'print a PRD as markdown'],
    ['approve <id>', 'approve and create ClickUp tickets'],
    ['reject <id>', 'reject a PRD'],
  ]);
  say('');
  say(c.bold('  Deploy'));
  table([['env --vercel', 'print env vars for your Vercel project']]);
  say('');
}

// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (args: string[]) => Promise<void> | void> = {
  init: cmdInit,
  doctor: cmdDoctor,
  'google:auth': cmdGoogleAuth,
  'clickup:discover': cmdClickUpDiscover,
  models: cmdModels,
  tick: cmdTick,
  watch: cmdWatch,
  scan: cmdScan,
  status: cmdStatus,
  show: cmdShow,
  approve: (a) => cmdDecide(a, 'approve'),
  reject: (a) => cmdDecide(a, 'reject'),
  env: cmdEnv,
  help: cmdHelp,
};

async function main() {
  const [, , rawCommand, ...args] = process.argv;
  const command = rawCommand ?? 'help';

  if (command === '--version' || command === '-v') {
    say(VERSION);
    return;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    cmdHelp();
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    fail(`Unknown command: ${command}`);
    cmdHelp();
    process.exitCode = 1;
    return;
  }

  try {
    await handler(args);
  } catch (err) {
    say('');
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    if (command !== 'watch') closePrompts();
  }
}

main();
