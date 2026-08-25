import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MeetingRecord } from './types.js';
import { CONFIG_DIR, getConfig } from './config.js';
import { log } from './logger.js';

export interface Store {
  get(id: string): Promise<MeetingRecord | null>;
  put(record: MeetingRecord): Promise<void>;
  list(): Promise<MeetingRecord[]>;
  delete(id: string): Promise<void>;
  readonly kind: string;
}

const KEY_PREFIX = 'meeting-prd:record:';
const INDEX_KEY = 'meeting-prd:index';

function touch(record: MeetingRecord): MeetingRecord {
  return { ...record, updatedAt: new Date().toISOString() };
}

/** Process-local. Fine for a single serverless invocation, lost between them. */
class MemoryStore implements Store {
  readonly kind = 'memory';
  private data = new Map<string, MeetingRecord>();

  async get(id: string) {
    return this.data.get(id) ?? null;
  }
  async put(record: MeetingRecord) {
    this.data.set(record.id, touch(record));
  }
  async list() {
    return [...this.data.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async delete(id: string) {
    this.data.delete(id);
  }
}

/** Default for local CLI runs: ~/.meeting-prd/state.json */
class FileStore implements Store {
  readonly kind = 'file';
  private path: string;

  constructor(dir = CONFIG_DIR) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'state.json');
  }

  private read(): Record<string, MeetingRecord> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (err) {
      log.warn('state.json unreadable, starting empty', String(err));
      return {};
    }
  }

  private write(data: Record<string, MeetingRecord>) {
    writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  async get(id: string) {
    return this.read()[id] ?? null;
  }
  async put(record: MeetingRecord) {
    const data = this.read();
    data[record.id] = touch(record);
    this.write(data);
  }
  async list() {
    return Object.values(this.read()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async delete(id: string) {
    const data = this.read();
    delete data[id];
    this.write(data);
  }
}

/**
 * Upstash Redis over its REST API — the only shape that works on Vercel's
 * serverless runtime, where TCP connections cannot be pooled between requests.
 */
class UpstashStore implements Store {
  readonly kind = 'upstash';

  constructor(
    private url: string,
    private token: string,
  ) {}

  private async cmd<T>(...args: (string | number)[]): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args.map(String)),
    });
    if (!res.ok) throw new Error(`Upstash ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { result: T };
    return json.result;
  }

  async get(id: string) {
    const raw = await this.cmd<string | null>('GET', KEY_PREFIX + id);
    return raw ? (JSON.parse(raw) as MeetingRecord) : null;
  }

  async put(record: MeetingRecord) {
    const next = touch(record);
    await this.cmd('SET', KEY_PREFIX + next.id, JSON.stringify(next));
    await this.cmd('SADD', INDEX_KEY, next.id);
  }

  async list() {
    const ids = await this.cmd<string[]>('SMEMBERS', INDEX_KEY);
    if (!ids?.length) return [];
    const raw = await this.cmd<(string | null)[]>('MGET', ...ids.map((i) => KEY_PREFIX + i));
    return raw
      .filter((r): r is string => Boolean(r))
      .map((r) => JSON.parse(r) as MeetingRecord)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string) {
    await this.cmd('DEL', KEY_PREFIX + id);
    await this.cmd('SREM', INDEX_KEY, id);
  }
}

let instance: Store | null = null;

/**
 * Upstash when configured, a JSON file when there is a writable home dir,
 * memory otherwise. The memory fallback keeps a bare Vercel deploy from
 * crashing, but state will not survive between invocations — /api/health
 * surfaces that so it is never a silent surprise.
 */
export function getStore(): Store {
  if (instance) return instance;
  const cfg = getConfig();

  if (cfg.upstashUrl && cfg.upstashToken) {
    instance = new UpstashStore(cfg.upstashUrl, cfg.upstashToken);
  } else if (process.env.VERCEL) {
    log.warn('No Upstash configured on Vercel — using memory store; state will not persist.');
    instance = new MemoryStore();
  } else {
    try {
      instance = new FileStore();
    } catch {
      instance = new MemoryStore();
    }
  }
  return instance;
}

export function setStore(store: Store): void {
  instance = store;
}

export { MemoryStore, FileStore, UpstashStore };
