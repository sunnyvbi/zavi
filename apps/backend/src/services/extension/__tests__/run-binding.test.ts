
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/supabase", async () => {
  const f = await import("./fake-ext-ops-db");
  return { serviceClient: () => f.fakeServiceClient };
});

import * as f from "./fake-ext-ops-db";
import { bindRunToPanelSession, readRunPanelBinding } from "@/services/extension/run-binding";
import {
  countTabTasksToday,
  panelSessionState,
  recordTabTaskStart,
  enqueueOp,
} from "@/services/extension/browser-ops";

const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UA = "11111111-1111-4111-8111-111111111111";
const UB = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";

function seedRun(r: Record<string, unknown> = {}) {
  f.db.tables.agent_runs = [
    { id: RUN, tenant_id: T1, enqueued_by: UA, actor_user_id: null, payload: { surface: "chrome_extension" }, ...r },
  ];
  return f.db.tables.agent_runs[0];
}

beforeEach(() => {
  f.resetDb();
  seedRun();
});

describe("bindRunToPanelSession (chat-send)", () => {
  it("binds the caller's own live session: tab from the session row, actor = the JWT user", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 42 });
    expect(await bindRunToPanelSession({ tenant_id: T1, user_id: UA, run_id: RUN, panel_session_id: s.id as string })).toBe(true);
    const run = f.db.tables.agent_runs[0];
    expect(run.actor_user_id).toBe(UA);
    expect(run.payload).toEqual({ surface: "chrome_extension", extension_panel: { panel_session_id: s.id, tab_id: 42 } });
    expect(await readRunPanelBinding(T1, RUN)).toEqual({ panel_session_id: s.id, tab_id: 42, user_id: UA });
  });

  it("ignores ANOTHER USER's session in the same tenant (no binding, no actor)", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UB, tab_id: 42 });
    expect(await bindRunToPanelSession({ tenant_id: T1, user_id: UA, run_id: RUN, panel_session_id: s.id as string })).toBe(false);
    expect(f.db.tables.agent_runs[0].actor_user_id).toBeNull();
    expect(f.db.tables.agent_runs[0].payload).toEqual({ surface: "chrome_extension" });
    expect(await readRunPanelBinding(T1, RUN)).toBeNull();
  });

  it("ignores the same user's session in ANOTHER TENANT", async () => {
    const s = f.seedSession({ tenant_id: T2, user_id: UA, tab_id: 42 });
    expect(await bindRunToPanelSession({ tenant_id: T1, user_id: UA, run_id: RUN, panel_session_id: s.id as string })).toBe(false);
    expect(await readRunPanelBinding(T1, RUN)).toBeNull();
  });

  it("ignores a DEAD session: ended, or not seen for 30s", async () => {
    const ended = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1, ended_at: new Date(f.now()).toISOString() });
    const stale = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1, last_seen_at: new Date(f.now() - 31_000).toISOString() });
    for (const s of [ended, stale]) {
      expect(await bindRunToPanelSession({ tenant_id: T1, user_id: UA, run_id: RUN, panel_session_id: s.id as string })).toBe(false);
    }
    expect(await readRunPanelBinding(T1, RUN)).toBeNull();
  });

  it("never writes another tenant's run", async () => {
    seedRun({ tenant_id: T2 });
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 42 });
    expect(await bindRunToPanelSession({ tenant_id: T1, user_id: UA, run_id: RUN, panel_session_id: s.id as string })).toBe(false);
    expect(f.db.tables.agent_runs[0].actor_user_id).toBeNull();
  });
});

describe("readRunPanelBinding (the tool's read side)", () => {
  const binding = { panel_session_id: "sess-1", tab_id: 7 };

  it("refuses a binding with no actor_user_id", async () => {
    seedRun({ payload: { extension_panel: binding }, actor_user_id: null });
    expect(await readRunPanelBinding(T1, RUN)).toBeNull();
  });

  it("refuses when the actor is not the person who sent the turn", async () => {
    seedRun({ payload: { extension_panel: binding }, actor_user_id: UB, enqueued_by: UA });
    expect(await readRunPanelBinding(T1, RUN)).toBeNull();
  });

  it("refuses a malformed binding and another tenant's run", async () => {
    seedRun({ payload: { extension_panel: { panel_session_id: 5, tab_id: "x" } }, actor_user_id: UA });
    expect(await readRunPanelBinding(T1, RUN)).toBeNull();
    seedRun({ payload: { extension_panel: binding }, actor_user_id: UA });
    expect(await readRunPanelBinding(T2, RUN)).toBeNull();
    expect(await readRunPanelBinding(T1, RUN)).toEqual({ ...binding, user_id: UA });
  });
});

describe("panelSessionState", () => {
  it("live / ended / stale / missing, owner-scoped", async () => {
    const live = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const ended = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1, ended_at: new Date(f.now()).toISOString() });
    const stale = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1, last_seen_at: new Date(f.now() - 31_000).toISOString() });
    expect(await panelSessionState(live.id as string, T1, UA, f.clock)).toBe("live");
    expect(await panelSessionState(ended.id as string, T1, UA, f.clock)).toBe("ended");
    expect(await panelSessionState(stale.id as string, T1, UA, f.clock)).toBe("stale");
    expect(await panelSessionState(live.id as string, T1, UB, f.clock)).toBe("missing");
    expect(await panelSessionState(live.id as string, T2, UA, f.clock)).toBe("missing");
  });
});

describe("tab-task daily cap unit", () => {
  it("one marker row per admitted task, counted per tenant per UTC day; never claimable", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 3 });
    const base = { tenant_id: T1, user_id: UA, run_id: RUN, session_id: s.id as string, tab_id: 3 };
    await recordTabTaskStart({ ...base, seq: 1, task_key: "toolu_a" }, f.clock);
    await recordTabTaskStart({ ...base, seq: 2, task_key: "toolu_b" }, f.clock);
    await enqueueOp({ ...base, seq: 3, op: { op: "ax_snapshot" }, is_write: false }, f.clock);
    expect(await countTabTasksToday(T1, f.clock)).toBe(2);
    expect(await countTabTasksToday(T2, f.clock)).toBe(0);
    const markers = f.db.tables.extension_browser_ops.filter((o) => String(o.idempotency_key ?? "").startsWith("tab_task:"));
    expect(markers.map((m) => m.status)).toEqual(["done", "done"]);
    const { claimNextOp } = await import("@/services/extension/browser-ops");
    const got = await claimNextOp(T1, UA, s.id as string, { waitMs: 0 }, f.clock);
    expect(got.kind === "op" && (got.op.op as { op: string }).op).toBe("ax_snapshot");
  });

  it("yesterday's tasks do not count", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 3 });
    await recordTabTaskStart({ tenant_id: T1, user_id: UA, run_id: RUN, session_id: s.id as string, tab_id: 3, seq: 1, task_key: "old" }, f.clock);
    f.db.tables.extension_browser_ops[0].created_at = new Date(f.now() - 2 * 86_400_000).toISOString();
    expect(await countTabTasksToday(T1, f.clock)).toBe(0);
  });
});
