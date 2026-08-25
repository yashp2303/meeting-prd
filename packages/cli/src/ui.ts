import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const useColor = stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  green: wrap('32'),
  red: wrap('31'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
  grey: wrap('90'),
};

export const say = (msg = ''): void => {
  stdout.write(msg + '\n');
};
export const ok = (msg: string): void => say(`${c.green('✓')} ${msg}`);
export const fail = (msg: string): void => say(`${c.red('✗')} ${msg}`);
export const warn = (msg: string): void => say(`${c.yellow('!')} ${msg}`);
export const info = (msg: string): void => say(`${c.blue('›')} ${msg}`);

export function heading(title: string) {
  say('');
  say(c.bold(title));
  say(c.grey('─'.repeat(Math.max(title.length, 24))));
}

let rl: ReturnType<typeof createInterface> | null = null;
function reader() {
  if (!rl) rl = createInterface({ input: stdin, output: stdout });
  return rl;
}

export function closePrompts() {
  rl?.close();
  rl = null;
}

export async function ask(question: string, fallback = ''): Promise<string> {
  const suffix = fallback ? c.grey(` [${fallback}]`) : '';
  const answer = (await reader().question(`${c.cyan('?')} ${question}${suffix}: `)).trim();
  return answer || fallback;
}

/**
 * Secrets are read with terminal echo suppressed so keys never end up visible
 * on screen or in a scrollback buffer.
 */
const ENTER = ['\r', '\n'];
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = ['\u007f', '\b'];

/**
 * Reads a secret with the characters masked.
 *
 * Three things make this fiddlier than it looks:
 *
 * 1. A paste arrives as a single chunk, not one keystroke at a time, so the
 *    chunk must be walked character by character rather than compared whole.
 * 2. Terminals wrap pastes in bracketed-paste escapes (ESC[200~ ... ESC[201~).
 *    Appending those verbatim corrupts the value, so an API key pasted that
 *    way is rejected as invalid -- which looks like a wrong key rather than a
 *    bug in this function.
 * 3. readline and a raw-mode listener cannot share stdin. Pausing stdin here
 *    leaves the shared readline interface dead, so the *next* prompt reads EOF
 *    and the process exits. Tear it down first and let it rebuild lazily.
 */
export async function askSecret(question: string, fallback = ''): Promise<string> {
  if (!stdin.isTTY) return ask(question, fallback);

  closePrompts();

  const suffix = fallback ? c.grey(` [${fallback.slice(0, 6)}\u2026]`) : '';
  stdout.write(`${c.cyan('?')} ${question}${suffix}: `);

  return new Promise((resolve) => {
    const previouslyRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    let buf = '';
    let done = false;

    const finish = (value: string) => {
      if (done) return;
      done = true;
      stdin.removeListener('data', onData);
      stdin.setRawMode(previouslyRaw ?? false);
      stdin.pause();
      stdout.write('\n');
      resolve(value);
    };

    const onData = (chunk: Buffer) => {
      // Strip bracketed-paste markers and any other CSI escape sequence before
      // inspecting individual characters.
      const text = chunk
        .toString('utf8')
        .replace(/\u001b\[20[01]~/g, '')
        .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

      for (const ch of text) {
        if (done) return;

        if (ENTER.includes(ch) || ch === CTRL_D) {
          finish(buf.trim() || fallback);
          return;
        }
        if (ch === CTRL_C) {
          stdout.write('\n');
          process.exit(130);
        }
        if (BACKSPACE.includes(ch)) {
          if (buf.length) {
            buf = buf.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        // Ignore any remaining control characters; mask everything printable.
        if (ch >= ' ' && ch !== '\u007f') {
          buf += ch;
          stdout.write('\u2022');
        }
      }
    };

    stdin.on('data', onData);
  });
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await ask(`${question} ${c.grey(`(${hint})`)}`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
}

export async function choose<T>(
  question: string,
  options: { label: string; value: T; hint?: string }[],
): Promise<T> {
  say('');
  options.forEach((o, i) => {
    say(`  ${c.bold(String(i + 1).padStart(2))}. ${o.label}${o.hint ? c.grey(`  ${o.hint}`) : ''}`);
  });
  say('');
  while (true) {
    const raw = await ask(question, '1');
    const idx = Number(raw) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < options.length) return options[idx]!.value;
    fail(`Enter a number between 1 and ${options.length}.`);
  }
}

export function table(rows: [string, string][], pad = 26) {
  for (const [k, v] of rows) say(`  ${c.grey(k.padEnd(pad))} ${v}`);
}

/** Minimal spinner that degrades to a single line when not attached to a TTY. */
export async function spin<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (!stdout.isTTY) {
    stdout.write(`… ${label}\n`);
    return task();
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const timer = setInterval(() => {
    stdout.write(`\r${c.cyan(frames[i++ % frames.length]!)} ${label}   `);
  }, 80);
  try {
    const result = await task();
    clearInterval(timer);
    stdout.write(`\r${' '.repeat(label.length + 8)}\r`);
    return result;
  } catch (err) {
    clearInterval(timer);
    stdout.write(`\r${' '.repeat(label.length + 8)}\r`);
    throw err;
  }
}
