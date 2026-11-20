import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  selects: [] as Array<{ table: string; cols: string }>,
  reads: 0,
  onRead: null as null | ((table: string) => void),
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let cols = "";
      const rows = () => {
        db.reads++;
        db.onRead?.(table);
        return (db.tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
      };
      const q: any = {
        select: (c: string) => ((cols = c), db.selects.push({ table, cols: c }), q),
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        limit: async () => {
          for (const c of cols.split(",").map((x) => x.trim())) if (!(table in db.tables) || (db.tables[table][0] && !(c in db.tables[table][0]))) return { data: null, error: { message: `column ${c} does not exist` } };
          return { data: rows(), error: null };
        },
        maybeSingle: async () => {
          for (const c of cols.split(",").map((x) => x.trim())) if (db.tables[table]?.[0] && !(c in db.tables[table][0])) return { data: null, error: { message: `column ${c} does not exist` } };
          return { data: rows()[0] ?? null, error: null };
        },
      };
      return q;
    },
  }),
}));

import { waitForFilingRun } from "../direct-ask-outcome";

beforeEach(() => {
  db.selects = [];
  db.reads = 0;
  db.onRead = null;
  vi.useFakeTimers();
  db.tables = {
    channel_actions: [{ id: "a1", run_id: "child-run" }],
    agent_runs: [{ id: "child-run", status: "running" }],
    agent_thread_messages: [],
    slack_outbox: [],
  };
});

describe("waitForFilingRun (the default, real query shape)", () => {
  it("reads channel_actions.run_id and waits for the run to finish and its chat reply to land", async () => {
    let done = false;
    const p = waitForFilingRun("t", "a1", { thread_id: "th-1", email: false }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(6000);
    expect(done).toBe(false);
    db.tables.agent_runs[0].status = "success";
    await vi.advanceTimersByTimeAsync(3000);
    expect(done).toBe(false);
    db.tables.agent_thread_messages.push({ id: "m1", thread_id: "th-1", agent_run_id: "child-run" });
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(done).toBe(true);
    expect(db.selects[0]).toEqual({ table: "channel_actions", cols: "run_id" });
  });

  it("a failed read is tried again, not taken as 'done' (Grok F3)", async () => {
    let fail = 2;
    db.onRead = (table) => { if (table === "agent_runs" && fail-- > 0) throw new Error("db blip"); };
    db.tables.agent_runs[0].status = "running";
    let done = false;
    const p = waitForFilingRun("t", "a1", { thread_id: null, email: false }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(7000);
    expect(done).toBe(false);
    db.tables.agent_runs[0].status = "success";
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(done).toBe(true);
  });

  it("on email, waits for the reply worker's sent row (email_messages out:<run>)", async () => {
    db.tables.agent_runs[0].status = "success";
    db.tables.email_messages = [];
    let done = false;
    const p = waitForFilingRun("t", "a1", { thread_id: null, email: true }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(done).toBe(false);
    db.tables.email_messages.push({ id: "e1", dedup_key: "out:child-run" });
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(done).toBe(true);
  });

  it("is bounded: a run stuck running releases the post", async () => {
    const p = waitForFilingRun("t", "a1", { thread_id: "th-1", email: false });
    await vi.advanceTimersByTimeAsync(310_000);
    await expect(p).resolves.toBeUndefined();
  });
});
