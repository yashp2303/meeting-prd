import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { calendar } from '@meeting-prd/core';

const { buildAuthUrl, exchangeCode } = calendar;
import { say, ok, warn, c } from './ui.js';

const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

function openBrowser(url: string) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

function html(title: string, body: string, good: boolean) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e8eaed;
font-family:-apple-system,system-ui,sans-serif}div{max-width:440px;padding:32px;text-align:center;
border:1px solid #262b33;border-radius:12px;background:#14171c}
h1{font-size:19px;margin:0 0 8px;color:${good ? '#6ee7b7' : '#f87171'}}p{color:#949ba6;font-size:14px;margin:0}</style>
<div><h1>${title}</h1><p>${body}</p></div>`;
}

/**
 * Runs the OAuth consent flow against a throwaway localhost listener and
 * returns the refresh token. `prompt=consent` is forced upstream so Google
 * always issues a refresh token, even on a repeat authorisation.
 */
export async function runGoogleAuth(
  clientId: string,
  clientSecret: string,
): Promise<{ refreshToken: string }> {
  const authUrl = buildAuthUrl(clientId, REDIRECT_URI);

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');

      if (error || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(html('Authorisation failed', error ?? 'No authorisation code was returned.', false));
        server.close();
        reject(new Error(error ?? 'No authorisation code returned'));
        return;
      }

      try {
        const tokens = await exchangeCode(code, clientId, clientSecret, REDIRECT_URI);
        if (!tokens.refresh_token) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(
            html(
              'No refresh token',
              'Google did not return a refresh token. Revoke this app at myaccount.google.com/permissions and try again.',
              false,
            ),
          );
          server.close();
          reject(new Error('Google returned no refresh_token'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html('Connected', 'Calendar access granted. You can close this tab.', true));
        server.close();
        resolve({ refreshToken: tokens.refresh_token });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(html('Token exchange failed', String(err), false));
        server.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${PORT} is busy. Close whatever is using it and retry.`)
          : err,
      );
    });

    server.listen(PORT, () => {
      say('');
      say(`  Add this redirect URI to your Google OAuth client first:`);
      say(`  ${c.bold(REDIRECT_URI)}`);
      say('');
      say(`  Opening your browser…`);
      say(c.grey(`  If it does not open: ${authUrl}`));
      openBrowser(authUrl);
    });

    setTimeout(
      () => {
        server.close();
        reject(new Error('Timed out after 5 minutes waiting for Google consent'));
      },
      5 * 60_000,
    ).unref();
  });
}

export function printGoogleSetupHelp() {
  warn('You need a Google OAuth client before this step.');
  say('');
  say(`  1. Open ${c.bold('console.cloud.google.com/apis/credentials')}`);
  say(`  2. Enable the ${c.bold('Google Calendar API')} for your project`);
  say(`  3. Create an ${c.bold('OAuth client ID')} of type ${c.bold('Web application')}`);
  say(`  4. Add this Authorised redirect URI: ${c.bold(REDIRECT_URI)}`);
  say(`  5. Under OAuth consent screen, add yourself as a ${c.bold('Test user')}`);
  say('');
  ok('Then paste the client ID and secret below.');
}
