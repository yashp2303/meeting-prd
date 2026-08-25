# meeting-prd

Turns a Google Meet conversation into ClickUp tickets, pausing for a human to approve the plan.

```
Google Calendar → Vexa bot → Google Meet → transcript
        → Groq → detailed PRD JSON → Slack approval
        → ClickUp features / stories / tasks
```

A calendar event with a Meet link gets a transcription bot. When the call ends, the transcript goes to
Groq, which writes a structured PRD. The PRD is posted to Slack for approval. Only after someone
approves does anything get created in ClickUp — as a Feature task, Story subtasks, and Task subtasks
underneath those.

---

## Install

```sh
brew tap yashp2303/tap
brew trust yashp2303/tap    # Homebrew 6 requires this once per third-party tap
brew install meeting-prd
meeting-prd init
```

<details>
<summary><code>Error: Your Command Line Tools are too outdated</code></summary>

Homebrew requires current Command Line Tools before installing any formula that
is not bottled. Unrelated to this package — fix it once:

```sh
sudo rm -rf /Library/Developer/CommandLineTools
sudo xcode-select --install
```

Or install without Homebrew — the CLI is a single file that needs only node:

```sh
curl -fsSL -o /usr/local/bin/meeting-prd \
  https://github.com/yashp2303/meeting-prd/releases/download/v0.1.0/meeting-prd.js
chmod +x /usr/local/bin/meeting-prd
```
</details>

`init` is an interactive wizard. It asks for each credential in turn and **verifies every one against
its live API before saving**, so a typo fails at setup rather than silently at 9am during a standup.

| Step | Asks for | Verified by |
| --- | --- | --- |
| 1 | Groq API key | listing models, then you pick which one writes PRDs |
| 2 | Vexa API key + base URL | a live `GET /bots/status` |
| 3 | Google Calendar | opens your browser for OAuth, then reads your next 7 days back to you |
| 4 | Slack webhook | posts a real test message |
| 5 | ClickUp token | reads your spaces and lists, then you **pick the target list from a menu** |
| 6 | — | signing secrets are generated, never prompted |

Everything lands in `~/.meeting-prd/config.json`, written `chmod 600`. No secret is ever committed
or logged.

Check it any time:

```sh
meeting-prd doctor
```

---

## Run it

```sh
meeting-prd tick        # one pass of the whole pipeline
meeting-prd watch       # tick every 5 minutes, locally
meeting-prd status      # what is being tracked right now
meeting-prd show <id>   # print a PRD as markdown
meeting-prd approve <id>
```

Locally, `watch` is enough. For the pipeline to run without your laptop open, deploy the web app.

---

## Deploy

The web app is the always-on half: it receives the Slack approval clicks, serves the review UI, and
exposes the tick endpoint.

```sh
vercel link
meeting-prd env --vercel     # prints every variable you need to set
vercel --prod
```

Then point `APP_BASE_URL` at the deployed origin and re-run `meeting-prd env --vercel` so the Slack
links resolve correctly.

### Why GitHub Actions runs the cron

Vercel's Hobby plan caps Cron at **one run per day**. This pipeline needs to notice a meeting starting
and then poll its transcript, so it wants roughly 5-minute granularity. `.github/workflows/tick.yml`
does that for free.

Add two repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `APP_BASE_URL` | your deployed origin, e.g. `https://meeting-prd.vercel.app` |
| `CRON_SECRET` | the same value you set in Vercel |

If you are on Vercel Pro, delete that workflow — `vercel.json` already declares the same schedule.

---

## How a decision gets back from Slack

A Slack **incoming webhook is send-only**. It can post a message but cannot deliver button clicks, and
receiving interactions would otherwise mean registering a full Slack app with a signing secret and a
public interactivity URL.

So approval is a **signed link** instead. Each button carries an HMAC-SHA256 token binding the meeting
id, the decision, and an expiry. The reject link cannot be edited into an approve link, and both stop
working after 7 days. Setup stays at "paste one webhook URL".

---

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `GROQ_API_KEY` | — | required |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | `meeting-prd models` lists what your key can reach |
| `GROQ_MAX_TOKENS` | `6000` | completion budget — see below |
| `GROQ_TPM_LIMIT` | `8000` | your tier's tokens-per-minute cap |
| `VEXA_API_KEY` | — | required |
| `VEXA_BASE_URL` | `https://api.cloud.vexa.ai` | point at `http://localhost:18056` to self-host |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | — | `meeting-prd google:auth` mints the token |
| `GOOGLE_CALENDAR_ID` | `primary` | |
| `SLACK_WEBHOOK_URL` | — | approval requests land here |
| `CLICKUP_API_TOKEN` | — | personal token, starts `pk_` |
| `CLICKUP_LIST_ID` | — | `meeting-prd clickup:discover` |
| `APP_BASE_URL` | `http://localhost:3000` | Slack links point here |
| `APPROVAL_SECRET` | — | HMAC key; generated by `init` |
| `CRON_SECRET` | — | bearer token guarding `/api/cron/tick` |
| `LOOKAHEAD_MINUTES` | `10` | how early the bot joins |
| `IDLE_TIMEOUT_MINUTES` | `5` | transcript silence before a call counts as over |
| `AUTO_APPROVE` | `0` | `1` skips Slack and publishes straight to ClickUp |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | — | see below |

### Groq tier limits

Two things about Groq shape how PRDs are generated, both learned the hard way:

**Tokens-per-minute counts the budget you reserve, not what you use.** A free
tier is 8000 TPM. Asking for a 16000-token completion fails with a 413 before
the model writes anything, even on a short transcript. `GROQ_MAX_TOKENS`
defaults to 6000 to stay inside that. If a request still overflows, the client
parses the limit out of the error and refits automatically rather than giving
up, and long transcripts are truncated from the front to fit — decisions
usually land at the end of a call.

**Strict structured output does not survive deep nesting.** The PRD schema is
four levels deep (`prd > features > stories > tasks`) and Groq rejects it under
`response_format: json_schema` with `json_validate_failed`. The schema is
therefore included in the prompt and plain `json_object` mode is used instead.
This is not a cosmetic difference: under strict mode the model returned
features with **zero stories**, which would have left nothing to create in
ClickUp.

On a paid tier, raise both variables — a larger completion budget lets the model
write longer PRDs before truncating.

### State

`meeting-prd` picks a store automatically:

- **Upstash Redis** when those two variables are set — the only option that persists on serverless.
- **`~/.meeting-prd/state.json`** locally.
- **Memory** as a last resort. On Vercel this means state is lost between requests, so the pipeline
  cannot advance a meeting past one stage. `/api/health` and the dashboard both say so loudly rather
  than failing quietly. Add the free Upstash integration in Vercel to fix it.

---

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /` | dashboard — every tracked meeting and its stage |
| `GET /prd/<id>` | full PRD, with approve and reject buttons |
| `POST /api/cron/tick` | one pipeline pass; bearer-guarded |
| `GET /api/decision?token=` | the signed Slack link target |
| `GET /api/health` | config and connectivity report |
| `GET /api/meetings` | JSON feed of tracked meetings |

---

## The pipeline, precisely

Each meeting is one record moving through stages. Every transition is guarded by the record's own
stage, so overlapping ticks cannot double-publish.

| Stage | Advances when |
| --- | --- |
| `scheduled` | found on the calendar with a Meet link |
| `dispatched` | within `LOOKAHEAD_MINUTES` of the start, bot sent to Vexa |
| `recording` | transcript segments are arriving |
| `transcribed` | past the scheduled end, or transcript static for `IDLE_TIMEOUT_MINUTES` |
| `drafted` | Groq returned a valid PRD |
| `awaiting_approval` | posted to Slack |
| `approved` / `rejected` | someone clicked |
| `published` | ClickUp tickets created |

**Vexa has no outbound webhooks** — transcripts are poll-only. That is the reason the whole system is
driven by a repeating tick rather than by callbacks.

---

## Repository layout

```
packages/core/   all logic, framework-free — clients, pipeline, PRD schema
packages/cli/    the meeting-prd binary, bundled to one file by esbuild
apps/web/        Next.js app: API routes + review UI
homebrew/        the tap formula
```

```sh
npm install
npm run build
npm run dev          # http://localhost:3000
```

## Licence

MIT
