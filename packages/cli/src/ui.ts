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
export async function askSecret(question: string, fallback = ''): Promise<string> {
  if (!stdin.isTTY) return ask(question, fallback);

  const suffix = fallback ? c.grey(` [${fallback.slice(0, 6)}…]`) : '';
  stdout.write(`${c.cyan('?')} ${question}${suffix}: `);

  return new Promise((resolve) => {
    const previouslyRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';

    const onData = (chunk: Buffer) => {
      const ch = chunk.toString('utf8');
      switch (ch) {
        case '\n':
        case '\r':
        case '':
          stdin.setRawMode(previouslyRaw ?? false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(buf.trim() || fallback);
          break;
        case '':
          stdout.write('\n');
          process.exit(130);
          break;
        case '':
        case '\b':
          if (buf.length) {
            buf = buf.slice(0, -1);
            stdout.write('\b \b');
          }
          break;
        default:
          if (ch >= ' ') {
            buf += ch;
            stdout.write('•');
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
