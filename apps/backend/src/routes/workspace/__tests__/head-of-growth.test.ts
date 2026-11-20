import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const T = "11111111-1111-4111-8111-111111111111";
const G = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ user_id: "u1", tenant_id: T, access_token: "tok" }),
}));
let role: "owner" | "admin" | "member" = "owner";
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_a: unknown, allowed: string[], res: Response) => {
    if (allowed.includes(role)) return true;
    res.status(403).json({ error: { code: "forbidden_role" } });
    return false;
  },
}));
const rpc = vi.fn(async () => ({ error: null }));
vi.mock("@/services/supabase", () => ({ serverClientFromBearer: () => ({ rpc }) }));
const setTenantSetting = vi.fn(async () => {});
vi.mock("@/services/settings", () => ({ setTenantSetting: (...a: unknown[]) => setTenantSetting(...(a as [])) }));

let row: Record<string, unknown> | null;
const writes: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }> = [];
const tenantRpc = vi.fn(async () => ({ data: "ok", error: null }));
const goalWriters: Array<Record<string, unknown>> = [];
function fakeGoalWrite(t: string, args: Record<string, unknown>) {
  const filters: Record<string, unknown> = { tenant_id: t, id: args.p_goal_id, ...((args.p_expect as Record<string, unknown>) ?? {}) };
  const patch = args.p_values as Record<string, unknown>;
  writes.push({ patch, filters });
  goalWriters.push(args);
  const match = row && Object.entries(filters).every(([k, v]) => (row![k] ?? null) === (v ?? null));
  if (match) Object.assign(row!, patch);
  return { data: match ? { status: "written", id: row!.id } : { status: "not_matched", id: null }, error: null };
}
const sgSend = vi.fn(async () => {});
vi.mock("@/email/sendAuthEmail", () => ({ sgSend: (...a: unknown[]) => sgSend(...(a as [])) }));
vi.mock("@/services/tenants/new-tenant-alert", () => ({ alertRecipient: () => "team@example.test" }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => tenantRpc(...(a as [])),
  tenantClient: () => ({
    from: () => {
      const filters: Record<string, unknown> = {};
      const notNull: string[] = [];
      let patch: Record<string, unknown> | null = null;
      const q = {
        select: () => q,
        update: (p: Record<string, unknown>) => ((patch = p), q),
        eq: (k: string, v: unknown) => ((filters[k] = v), q),
        not: (k: string) => (notNull.push(k), q),
        maybeSingle: async () => ({ data: row && row.tenant_id === filters.tenant_id ? row : null, error: null }),
        then: (ok: (v: unknown) => unknown) => {
          const match =
            row && Object.entries(filters).every(([k, v]) => row![k] === v) && notNull.every((k) => row![k] != null);
          if (patch) writes.push({ patch, filters: { ...filters } });
          if (match && patch) Object.assign(row!, patch);
          return Promise.resolve({ data: match ? [row] : [], error: null }).then(ok);
        },
      };
      return q;
    },
  }),
}));

import { putGrowthAutopilot, postAutopilotMistake, postChannelSeen, postUndoCgoChange } from "../head-of-growth";
import { goalRev } from "@/services/growth/goal-owner";

function call(handler: (req: Request, res: Response) => Promise<void>, req: Partial<Request>) {
  const out: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    status: (s: number) => ((out.status = s), res),
    json: (b: unknown) => ((out.body = b), res),
    end: () => res,
  } as unknown as Response;
  return handler(req as Request, res).then(() => out);
}

const current = { objective: "Get 12 signups", target_metric: "signups", target_value: 12, due_date: "2026-11-14" };

beforeEach(() => {
  writes.length = 0;
  goalWriters.length = 0;
  tenantRpc
    .mockReset()
    .mockImplementation((async (t: string, fn: string, args: Record<string, unknown>) =>
      fn === "write_autopilot_goal" ? fakeGoalWrite(t, args) : { data: "ok", error: null }) as never);
  sgSend.mockReset().mockResolvedValue(undefined);
  setTenantSetting.mockClear();
  rpc.mockClear();
  role = "owner";
  row = {
    id: G,
    tenant_id: T,
    status: "active",
    ...current,
    current_value: 10,
    baseline_value: 1,
    updated_at: "2026-09-26T12:00:00Z",
    cgo_undo: {
      prev: { objective: "Get 20 signups", target_metric: "signups", target_value: 20, due_date: "2026-10-31", current_value: 6, baseline_value: null, measurement_mode: "manual_reported" },
      rev: goalRev(current),
    },
  };
});

describe("undo a cgo goal change", () => {
  it("puts the previous ask back and clears the undo; progress reported since stays", async () => {
    const out = await call(postUndoCgoChange, { params: { id: G } as never });
    expect(out.status).toBe(200);
    expect(row).toMatchObject({ objective: "Get 20 signups", target_value: 20, due_date: "2026-10-31", current_value: 10, baseline_value: 1, cgo_undo: null });
    expect(writes[0].filters).toMatchObject({ tenant_id: T, id: G, status: "active", updated_at: "2026-09-26T12:00:00Z" });
    expect(goalWriters[0]).toMatchObject({ p_op: "update", p_actor_source: "founder", p_actor_user_id: "u1", p_why: "Undo" });
  });

  it("when cgo had changed the metric, the old number comes back with it", async () => {
    const now = { ...current, target_metric: "paying_customers" };
    row = { ...row!, ...now, current_value: null, baseline_value: null, measurement_mode: "auto", cgo_undo: { ...(row!.cgo_undo as object), rev: goalRev(now) } };
    const out = await call(postUndoCgoChange, { params: { id: G } as never });
    expect(out.status).toBe(200);
    expect(row).toMatchObject({ target_metric: "signups", current_value: 6, baseline_value: null, measurement_mode: "manual_reported" });
  });

  it("refuses when the goal was changed again since", async () => {
    row!.target_value = 15;
    const out = await call(postUndoCgoChange, { params: { id: G } as never });
    expect(out.status).toBe(409);
    expect(writes).toHaveLength(0);
  });

  it("refuses when there is nothing to undo, or the goal is not active, or it is another workspace's", async () => {
    row!.cgo_undo = null;
    expect((await call(postUndoCgoChange, { params: { id: G } as never })).status).toBe(404);
    row = { ...row!, cgo_undo: { prev: { objective: "x", target_metric: "y" }, rev: goalRev(current) }, status: "paused" };
    expect((await call(postUndoCgoChange, { params: { id: G } as never })).status).toBe(404);
    row = { ...row!, status: "active", tenant_id: "99999999-9999-4999-8999-999999999999" };
    expect((await call(postUndoCgoChange, { params: { id: G } as never })).status).toBe(404);
    expect(writes).toHaveLength(0);
  });
});

describe("undo a cgo goal change: owner/admin only", () => {
  it("a member is refused and nothing is written", async () => {
    role = "member";
    const out = await call(postUndoCgoChange, { params: { id: G } as never });
    expect(out.status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});

describe("autopilot switch and channel seen", () => {
  const autopilotRpc = (data: unknown) =>
    tenantRpc.mockImplementation((async (_t: string, fn: string) =>
      fn === "set_cgo_autopilot" ? { data, error: null } : { data: "ok", error: null }) as never);

  it("sets it through one RPC for the session's tenant only, from a strict boolean", async () => {
    autopilotRpc({ ok: true, enabled: true, prior: false, on_at: "2026-10-12T10:00:00Z" });
    const ok = await call(putGrowthAutopilot, { body: { enabled: true, tenant_id: "someone-else" } });
    expect(ok).toEqual({ status: 200, body: { autopilot: true } });
    expect(tenantRpc).toHaveBeenCalledWith(T, "set_cgo_autopilot", { p_enabled: true, p_actor_user_id: "u1" });
    expect(setTenantSetting).not.toHaveBeenCalled();
    expect((await call(putGrowthAutopilot, { body: { enabled: "yes" } })).status).toBe(400);
  });

  it("a member cannot turn Autopilot on (it lets Zavi run every channel): refused before any write", async () => {
    role = "member";
    autopilotRpc({ ok: true, enabled: true });
    const out = await call(putGrowthAutopilot, { body: { enabled: true } });
    expect(out.status).toBe(403);
    expect(tenantRpc).not.toHaveBeenCalled();
  });

  it("the database's own role check wins: not_owner_or_admin is a 403, an unconfirmed write a 500", async () => {
    autopilotRpc({ ok: false, code: "not_owner_or_admin" });
    expect((await call(putGrowthAutopilot, { body: { enabled: true } })).status).toBe(403);
    autopilotRpc(null);
    expect((await call(putGrowthAutopilot, { body: { enabled: false } })).status).toBe(500);
  });

  it("marks a channel seen through the RPC (tenant derived in the database)", async () => {
    const out = await call(postChannelSeen, { body: { slug: "reddit_organic" } });
    expect(out.status).toBe(204);
    expect(rpc).toHaveBeenCalledWith("mark_channel_seen", { p_channel_slug: "reddit_organic" });
  });
});

describe("the Autopilot Guarantee: 'This was a mistake'", () => {
  const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
  const replies: Record<string, { data: unknown; error: { message: string } | null }> = {};
  beforeEach(() => {
    replies.claim_cgo_pause = { data: { ok: true, why: "9 posts untouched.", at: recent, run_id: "run-7" }, error: null };
    replies.refund_autopilot_run = { data: { status: "refunded", credits: 400 }, error: null };
    tenantRpc.mockImplementation((async (t: string, fn: string, args: Record<string, unknown>) =>
      replies[fn] ?? (fn === "write_autopilot_goal" ? fakeGoalWrite(t, args) : { data: "ok", error: null })) as never);
  });
  const rpcCalls = (fn: string) => (tenantRpc.mock.calls as unknown as unknown[][]).filter((c) => c[1] === fn);

  it("a goal change within 30 days: undone, its check-in refunded, the claim emailed", async () => {
    (row!.cgo_undo as Record<string, unknown>).at = recent;
    (row!.cgo_undo as Record<string, unknown>).why = "Behind pace.";
    (row!.cgo_undo as Record<string, unknown>).run_id = "run-9";
    const out = await call(postAutopilotMistake, { body: { kind: "goal", goal_id: G } });
    expect(out).toEqual({ status: 200, body: { ok: true, refund: { status: "refunded", credits: 400, forfeited: 0, untracked: 0 }, claim_sent: true } });
    expect(row).toMatchObject({ objective: "Get 20 signups", target_value: 20, cgo_undo: null });
    expect(rpcCalls("refund_autopilot_run")[0]).toEqual([T, "refund_autopilot_run", { p_run_id: "run-9" }]);
    const [to, subject, , text] = sgSend.mock.calls[0] as unknown as [string, string, string, string];
    expect(to).toBe("team@example.test");
    expect(subject).toContain("Autopilot Guarantee claim");
    expect(text).toContain('Goal change on "Get 20 signups" (Behind pace.)');
    expect(text).toContain("Refund: refunded (400 credits back, 0 forfeited from a window that has since reset).");
  });

  it("refuses a change older than 30 days: nothing undone, refunded or emailed", async () => {
    (row!.cgo_undo as Record<string, unknown>).at = old;
    const out = await call(postAutopilotMistake, { body: { kind: "goal", goal_id: G } });
    expect(out.status).toBe(409);
    expect(writes).toHaveLength(0);
    expect(rpcCalls("refund_autopilot_run")).toHaveLength(0);
    expect(sgSend).not.toHaveBeenCalled();
  });

  it("a channel pause: claimed in the database with the 30-day window, then its check-in refunded", async () => {
    const out = await call(postAutopilotMistake, { body: { kind: "channel", channel_slug: "reddit_organic" } });
    expect(out.status).toBe(200);
    expect(rpcCalls("claim_cgo_pause")[0]).toEqual([T, "claim_cgo_pause", { p_channel_slug: "reddit_organic", p_window_days: 30 }]);
    expect(rpcCalls("refund_autopilot_run")[0]).toEqual([T, "refund_autopilot_run", { p_run_id: "run-7" }]);
    expect(sgSend).toHaveBeenCalledTimes(1);
  });

  it("a member cannot claim: nothing undone, no claim", async () => {
    role = "member";
    (row!.cgo_undo as Record<string, unknown>).at = recent;
    const out = await call(postAutopilotMistake, { body: { kind: "goal", goal_id: G } });
    expect(out.status).toBe(403);
    expect(writes).toHaveLength(0);
    expect(tenantRpc).not.toHaveBeenCalled();
    expect(sgSend).not.toHaveBeenCalled();
  });

  it("each database refusal maps to its status, with no refund and no email", async () => {
    for (const [code, status] of [["nothing_to_undo", 404], ["outside_window", 409], ["plan_changed", 409]] as const) {
      replies.claim_cgo_pause = { data: { ok: false, code }, error: null };
      const out = await call(postAutopilotMistake, { body: { kind: "channel", channel_slug: "reddit_organic" } });
      expect(out.status).toBe(status);
      expect((out.body as { error: { code: string } }).error.code).toBe(code);
    }
    expect(rpcCalls("refund_autopilot_run")).toHaveLength(0);
    expect(sgSend).not.toHaveBeenCalled();
  });

  it("a failed channel claim is a 500 with no refund", async () => {
    replies.claim_cgo_pause = { data: null, error: { message: "boom" } };
    const out = await call(postAutopilotMistake, { body: { kind: "channel", channel_slug: "reddit_organic" } });
    expect(out.status).toBe(500);
    expect(rpcCalls("refund_autopilot_run")).toHaveLength(0);
  });

  it("if the refund fails, the change stays undone and the team is told to refund by hand", async () => {
    replies.refund_autopilot_run = { data: null, error: { message: "wallet locked" } };
    const out = await call(postAutopilotMistake, { body: { kind: "channel", channel_slug: "reddit_organic" } });
    expect(out.body).toEqual({ ok: true, refund: { status: "failed", credits: 0, forfeited: 0, untracked: 0 }, claim_sent: true });
    const text = (sgSend.mock.calls[0] as unknown as string[])[3];
    expect(text).toContain("No automatic refund (failed): refund the credits it used by hand.");
  });

  it("passes through already-refunded and nothing-charged", async () => {
    for (const d of [{ status: "already_refunded", credits: 400 }, { status: "nothing_charged", credits: 0 }]) {
      replies.refund_autopilot_run = { data: d, error: null };
      const out = await call(postAutopilotMistake, { body: { kind: "channel", channel_slug: "reddit_organic" } });
      expect((out.body as { refund: unknown }).refund).toEqual({ ...d, forfeited: 0, untracked: 0 });
    }
  });

  it("daily, monthly and purchased credits back: relays the total and tells the team", async () => {
    replies.refund_autopilot_run = {
      data: { status: "refunded", credits: 650, daily: 300, included: 200, purchased: 150, forfeited: 0, untracked: 0 },
      error: null,
    };
    const out = await call(postAutopilotMistake, { body: { kind: "channel", channel_slug: "reddit_organic" } });
    expect((out.body as { refund: unknown }).refund).toEqual({ status: "refunded", credits: 650, forfeited: 0, untracked: 0 });
    expect((sgSend.mock.calls[0] as unknown as string[])[3]).toContain("Refund: refunded (650 credits back, 0 forfeited from a window that has since reset).");
  });

  it("reserved before midnight and settled after: the daily part is forfeited, not paid as purchased", async () => {
    replies.refund_autopilot_run = { data: { status: "expired", credits: 0, daily: 0, forfeited: 100, untracked: 0 }, error: null };
    const out = await call(postAutopilotMistake, { body: { kind: "channel", channel_slug: "reddit_organic" } });
    expect((out.body as { refund: unknown }).refund).toEqual({ status: "expired", credits: 0, forfeited: 100, untracked: 0 });
    expect((sgSend.mock.calls[0] as unknown as string[])[3]).toContain("Refund: expired (0 credits back, 100 forfeited from a window that has since reset).");
  });

  it("a replayed claim gives nothing more", async () => {
    replies.refund_autopilot_run = { data: { status: "already_refunded", credits: 0 }, error: null };
    const out = await call(postAutopilotMistake, { body: { kind: "channel", channel_slug: "reddit_organic" } });
    expect((out.body as { refund: unknown }).refund).toEqual({ status: "already_refunded", credits: 0, forfeited: 0, untracked: 0 });
  });

  it("an unverified charge: nothing paid automatically, the team reviews it and refunds only what is owed", async () => {
    replies.refund_autopilot_run = { data: { status: "untracked", credits: 0, forfeited: 100, untracked: 90 }, error: null };
    await call(postAutopilotMistake, { body: { kind: "channel", channel_slug: "reddit_organic" } });
    const text = (sgSend.mock.calls[0] as unknown as string[])[3];
    expect(text).toContain("Refund: untracked (0 credits back, 100 forfeited from a window that has since reset, 90 unverified");
    expect(text).toContain("refund only what is owed");
    expect(text).not.toContain("refund the credits it used by hand");
    sgSend.mockClear();
    replies.refund_autopilot_run = { data: { status: "refunded", credits: 70, forfeited: 0, untracked: 50 }, error: null };
    await call(postAutopilotMistake, { body: { kind: "channel", channel_slug: "reddit_organic" } });
    expect((sgSend.mock.calls[0] as unknown as string[])[3]).toContain("50 unverified: their source could not be checked automatically");
  });

  it("never relays a negative or fractional credit count", async () => {
    replies.refund_autopilot_run = { data: { status: "refunded", credits: -5.5, forfeited: "x" }, error: null };
    const out = await call(postAutopilotMistake, { body: { kind: "channel", channel_slug: "reddit_organic" } });
    expect((out.body as { refund: unknown }).refund).toEqual({ status: "refunded", credits: 0, forfeited: 0, untracked: 0 });
  });

  it("if the claim email fails, the page is told the claim did not go out", async () => {
    (row!.cgo_undo as Record<string, unknown>).at = recent;
    sgSend.mockRejectedValueOnce(new Error("sendgrid down"));
    const out = await call(postAutopilotMistake, { body: { kind: "goal", goal_id: G } });
    expect(out).toEqual({ status: 200, body: { ok: true, refund: { status: "refunded", credits: 400, forfeited: 0, untracked: 0 }, claim_sent: false } });
  });

  it("rejects a body that names no change", async () => {
    expect((await call(postAutopilotMistake, { body: { kind: "goal" } })).status).toBe(400);
  });
});
