import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  run: { data: { stop_requested: false, agent_slug: "email_marketing" } as unknown, error: null as unknown },
  kill: { data: null as unknown, error: null as unknown },
  throws: false,
  filters: {} as Record<string, string[]>,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    if (db.throws) throw new Error("no db");
    return {
      from: (table: string) => {
        const res = table === "agent_runs" ? db.run : db.kill;
        const f = (db.filters[table] = [] as string[]);
        const q = {
          select: (cols: string) => (f.push(`select:${cols}`), q),
          eq: (col: string, v: unknown) => (f.push(`${col}=${String(v)}`), q),
          maybeSingle: async () => res,
        };
        return q;
      },
    };
  },
}));

import { runMayActNow } from "../run-may-act";

beforeEach(() => {
  db.run = { data: { stop_requested: false, agent_slug: "email_marketing" }, error: null };
  db.kill = { data: null, error: null };
  db.throws = false;
  db.filters = {};
});

describe("runMayActNow", () => {
  it("a live run of a live agent may act, read by exactly the run, its tenant, and a staff hide row", async () => {
    expect(await runMayActNow("t", "r")).toBe(true);
    expect([...db.filters.agent_runs].sort()).toEqual(["id=r", "select:stop_requested, agent_slug", "tenant_id=t"]);
    expect([...db.filters.tenant_agent_kill_switch].sort()).toEqual([
      "agent_slug=email_marketing",
      "override_state=hidden",
      "select:agent_slug",
      "source=staff",
      "tenant_id=t",
    ]);
  });
  it("a stopped run may not", async () => {
    db.run = { data: { stop_requested: true, agent_slug: "email_marketing" }, error: null };
    expect(await runMayActNow("t", "r")).toBe(false);
  });
  it("a killed agent may not", async () => {
    db.kill = { data: { agent_slug: "email_marketing" }, error: null };
    expect(await runMayActNow("t", "r")).toBe(false);
  });
  it("fails closed: a run read error, a missing run, a kill read error, a throw", async () => {
    db.run = { data: null, error: { message: "x" } };
    expect(await runMayActNow("t", "r")).toBe(false);
    db.run = { data: null, error: null };
    expect(await runMayActNow("t", "r")).toBe(false);
    db.run = { data: { stop_requested: false, agent_slug: "email_marketing" }, error: null };
    db.kill = { data: null, error: { message: "x" } };
    expect(await runMayActNow("t", "r")).toBe(false);
    db.throws = true;
    expect(await runMayActNow("t", "r")).toBe(false);
  });
});
