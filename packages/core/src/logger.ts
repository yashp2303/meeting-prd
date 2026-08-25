type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function emit(level: Level, msg: string, meta?: unknown) {
  if (ORDER[level] < threshold) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  if (meta === undefined) stream(line);
  else stream(line, typeof meta === 'string' ? meta : JSON.stringify(meta));
}

export const log = {
  debug: (m: string, meta?: unknown) => emit('debug', m, meta),
  info: (m: string, meta?: unknown) => emit('info', m, meta),
  warn: (m: string, meta?: unknown) => emit('warn', m, meta),
  error: (m: string, meta?: unknown) => emit('error', m, meta),
};

/** Never let a secret reach a log line or an HTTP error body. */
export function redact(text: string): string {
  return text
    .replace(/gsk_[A-Za-z0-9]{20,}/g, 'gsk_***')
    .replace(/pk_[A-Za-z0-9_]{20,}/g, 'pk_***')
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***')
    .replace(/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, 'hooks.slack.com/services/***')
    .replace(/(refresh_token"\s*:\s*")[^"]+/g, '$1***');
}
