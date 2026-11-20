import { appendFileSync, existsSync, mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { ActivityLog } from "../activity";

const entry = (i: number, size = 100) => ({ request_id: `r${i}`, op: "sql", query: `q${i}`, decision: "allowed" as const, reason: null, rows: i, bytes: size, delivery: "delivered" as const, sent: "x".repeat(size) });

describe("activity log", () => {
  it("is 0600, newest first, and returns the exact payload by id", () => {
    const dir = mkdtempSync(join(tmpdir(), "zc-act-"));
    const log = new ActivityLog(dir);
    const a = log.append(entry(1));
    log.append(entry(2));
    expect(statSync(log.path).mode & 0o777).toBe(0o600);
    expect(log.list().map((r) => r.request_id)).toEqual(["r2", "r1"]);
    expect(log.get(a.id)!.sent).toBe("x".repeat(100));
    expect("sent" in log.list()[0]!).toBe(false);
  });
  it("is bounded: rotates at the size cap, keeps one previous file, and drops an old rotated file", () => {
    const dir = mkdtempSync(join(tmpdir(), "zc-act-"));
    let now = Date.now();
    const log = new ActivityLog(dir, { maxBytes: 2_000, maxRotatedAgeMs: 1_000, now: () => now });
    for (let i = 0; i < 60; i++) log.append(entry(i, 300));
    expect(statSync(log.path).size).toBeLessThanOrEqual(2_000);
    expect(statSync(log.path + ".1").size).toBeLessThanOrEqual(2_000);
    const rows = log.list(1000);
    expect(rows[0]!.request_id).toBe("r59");
    expect(rows.length).toBeLessThan(60);
    now += 10_000;
    utimesSync(log.path + ".1", new Date(now - 5_000), new Date(now - 5_000));
    log.sweep();
    expect(existsSync(log.path + ".1")).toBe(false);
  });
  it("tolerates a torn last line after a crash and large payload lines across read chunks", () => {
    const dir = mkdtempSync(join(tmpdir(), "zc-act-"));
    const log = new ActivityLog(dir);
    log.append(entry(1, 600_000));
    log.append(entry(2, 10));
    appendFileSync(log.path, '{"id":"torn');
    expect(log.list().map((r) => r.request_id)).toEqual(["r2", "r1"]);
  });
});
