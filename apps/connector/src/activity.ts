import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const ACTIVITY_FILE = "activity.log";
export const MAX_ACTIVITY_BYTES = 50 * 1024 * 1024;
export const MAX_ROTATED_AGE_MS = 30 * 24 * 3600 * 1000;

export type Decision = "allowed" | "refused" | "failed";
export type Delivery = "delivered" | "stale" | "rejected" | "not_delivered";

export type ActivityEntry = {
  id: string;
  at: string;
  request_id: string;
  op: string;
  query: string;
  decision: Decision;
  reason: string | null;
  rows: number;
  bytes: number;
  delivery: Delivery;
  sent: string;
};
export type ActivityRow = Omit<ActivityEntry, "sent">;

const CHUNK = 256 * 1024;

function* linesFromEnd(path: string): Generator<string> {
  if (!existsSync(path)) return;
  const fd = openSync(path, "r");
  try {
    let pos = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      let data = Buffer.concat([buf, carry]);
      let nl = data.lastIndexOf(0x0a);
      while (nl !== -1) {
        const line = data.subarray(nl + 1).toString("utf8");
        if (line.trim()) yield line;
        data = data.subarray(0, nl);
        nl = data.lastIndexOf(0x0a);
      }
      carry = data;
    }
    const first = carry.toString("utf8");
    if (first.trim()) yield first;
  } finally {
    closeSync(fd);
  }
}

export class ActivityLog {
  readonly path: string;
  private readonly rotated: string;

  constructor(
    dataDir: string,
    private readonly opts: { maxBytes?: number; maxRotatedAgeMs?: number; now?: () => number } = {},
  ) {
    this.path = join(dataDir, ACTIVITY_FILE);
    this.rotated = `${this.path}.1`;
  }

  private get maxBytes() {
    return this.opts.maxBytes ?? MAX_ACTIVITY_BYTES;
  }
  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  append(e: Omit<ActivityEntry, "id" | "at">): ActivityEntry {
    const entry: ActivityEntry = { id: randomUUID(), at: new Date(this.now()).toISOString(), ...e };
    const line = JSON.stringify(entry) + "\n";
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
      renameSync(this.path, this.rotated);
    }
    appendFileSync(this.path, line, { mode: 0o600 });
    return entry;
  }

  list(limit = 200): ActivityRow[] {
    const out: ActivityRow[] = [];
    for (const file of [this.path, this.rotated]) {
      for (const line of linesFromEnd(file)) {
        try {
          const { sent: _sent, ...row } = JSON.parse(line) as ActivityEntry;
          out.push(row);
        } catch {
          continue;
        }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  get(id: string): ActivityEntry | null {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const needle = `"id":"${id}"`;
    for (const file of [this.path, this.rotated]) {
      for (const line of linesFromEnd(file)) {
        if (!line.includes(needle)) continue;
        try {
          const e = JSON.parse(line) as ActivityEntry;
          if (e.id === id) return e;
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  sweep(): void {
    try {
      if (this.now() - statSync(this.rotated).mtimeMs > (this.opts.maxRotatedAgeMs ?? MAX_ROTATED_AGE_MS)) rmSync(this.rotated, { force: true });
    } catch {
    }
  }
}
