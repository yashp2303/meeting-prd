import { NextResponse } from 'next/server';
import { verifyApproval, applyDecision, approveAndPublish, getConfig } from '@meeting-prd/core';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The endpoint the Slack buttons point at.
 *
 * Slack incoming webhooks cannot deliver interactions, so approval arrives as a
 * signed link instead. The HMAC binds the meeting id to a single decision, so
 * the reject URL cannot be hand-edited into an approve URL.
 */
function page(title: string, body: string, ok: boolean) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e8eaed;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.box{max-width:520px;padding:32px;border:1px solid #262b33;border-radius:12px;background:#14171c;text-align:center}
h1{font-size:20px;margin:0 0 10px;color:${ok ? '#6ee7b7' : '#f87171'}}
p{color:#949ba6;font-size:14px;line-height:1.6;margin:0 0 20px}
a{color:#6ee7b7;font-size:13px}
@media (prefers-color-scheme:light){body{background:#f7f8fa;color:#14171c}.box{background:#fff;border-color:#e2e5ea}}
</style></head>
<body><div class="box"><h1>${title}</h1><p>${body}</p><a href="/">Open the dashboard</a></div></body></html>`,
    { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

export async function GET(request: Request) {
  const cfg = getConfig();
  const token = new URL(request.url).searchParams.get('token');

  if (!token) return page('Missing token', 'This link is incomplete.', false);

  const verified = verifyApproval(token, cfg.approvalSecret);
  if (!verified.ok) {
    return page(
      'Link not valid',
      `${verified.reason}. Approval links expire after 7 days — open the dashboard and decide there instead.`,
      false,
    );
  }

  const { id, decision } = verified.claims;

  try {
    if (decision === 'reject') {
      const result = await applyDecision(id, 'reject', 'slack', cfg);
      return page(result.ok ? 'Rejected' : 'Could not reject', result.message, result.ok);
    }

    const result = await approveAndPublish(id, 'slack', cfg);
    return page(
      result.ok ? 'Approved' : 'Approved, but publishing failed',
      result.message,
      result.ok,
    );
  } catch (err) {
    return page('Something went wrong', err instanceof Error ? err.message : String(err), false);
  }
}
