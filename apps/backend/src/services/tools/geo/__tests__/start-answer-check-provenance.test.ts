import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rows: {} as Record<string, Record<string, unknown>[]>, open: vi.fn(), claim: vi.fn() }));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<object>()),
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: (table: string) => {
    const filters: Record<string, unknown> = {};
    const q = {
      select: () => q,
      eq: (key: string, value: unknown) => (filters[key] = value, q),
      maybeSingle: async () => ({ error: null, data: (m.rows[table] ?? []).find(row => Object.entries(filters).every(([k, v]) => row[k] === v)) ?? null }),
    };
    return q;
  } }),
}));
vi.mock("@/services/tools/growth/geo/visibility/sweep", () => ({ openSweep: m.open }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/mcp/tool-effect-ledger", async (orig) => ({
  ...(await orig<object>()),
  realToolEffectDeps: { lookupCommitted: async () => null, claimPending: m.claim, commit: async () => {}, release: async () => {} },
}));
vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig));
import { tenantClient, asTenantId } from "@/services/tenant-client";
import { resolveFounderChatOrder, type FounderOrderClaim } from "@/services/growth/founder-order";
import { callGeoTool } from "@/services/mcp/internal/geo";
import { resetTenantPlan, tenantPlan } from "@/__tests__/helpers/tenant-plan";

const T = "tenant-fixture";
const root = { id: "root", tenant_id: T, agent_slug: "operator", trigger: "chat", enqueued_by: "owner", payload: { thread_id: "thread", user_message_id: "message" } };
const child = { id: "child", tenant_id: T, agent_slug: "geo", trigger: "handoff", enqueued_by: null, payload: {
  thread_id: "geo-thread", operator_thread_id: "thread", founder_message_ref: { kind: "chat", id: "message", author_user_id: "owner", run_id: "root" },
} };
const resume = (handoff: boolean) => ({ id: "resume", tenant_id: T, agent_slug: handoff ? "geo" : "operator", trigger: handoff ? "handoff" : "chat", enqueued_by: null,
  payload: { thread_id: handoff ? "geo-thread" : "thread", resume_of_run_id: handoff ? "child" : "root", internal_resume_turn: "continue" },
});
let role = "owner";
beforeEach(() => {
  vi.clearAllMocks(); resetTenantPlan(); tenantPlan.tier = "starter"; role = "owner";
  m.rows.agent_runs = [structuredClone(root), structuredClone(child)];
  m.rows.agent_thread_messages = [{ id: "message", tenant_id: T, thread_id: "thread", sender_role: "user", agent_run_id: "root", body: "proceed", created_at: new Date().toISOString() }];
  m.open.mockResolvedValue({ ok: true, sweep_id: "sweep", planned: 60, country: "US", runner: "worker" });
  m.claim.mockResolvedValue(true);
});
async function invoke(run: FounderOrderClaim) {
  const db = tenantClient(asTenantId(T)) as unknown as Parameters<typeof resolveFounderChatOrder>[0];
  const order = await resolveFounderChatOrder(db, run, { roleOf: async () => role });
  return callGeoTool({
    tenant_id: T, run_id: run.id, run_trigger: run.trigger ?? undefined,
    founder_chat_order: order.founder, founder_order_unverified: order.unverified,
    founder_order_group: order.order_root_id ?? undefined,
  }, "start_answer_check", {});
}
describe("GEO check uses real founder provenance and resume resolution", () => {
  it.each([false, true])("resolves a server resume, handoff=%s, to the original human turn", async (handoff) => {
    const run = resume(handoff); m.rows.agent_runs.push(run);
    const result = await invoke(run);
    expect(JSON.parse(result.content)).toMatchObject({ sweep_id: "sweep", status: "started" });
    expect(m.open).toHaveBeenCalledWith(T, { requestedBy: "owner", country: null }, expect.any(Object));
    expect(m.claim).toHaveBeenCalledWith(expect.objectContaining({ run_id: "root" }));
  });
  it("does not accept a user-forged handoff", async () => {
    const forged = { ...child, enqueued_by: "owner" };
    expect((await invoke(forged)).is_error).toBe(true); expect(m.open).not.toHaveBeenCalled();
  });
  it("does not accept a foreign-tenant origin", async () => {
    m.rows.agent_runs[0].tenant_id = "another-tenant";
    expect((await invoke(child)).is_error).toBe(true); expect(m.open).not.toHaveBeenCalled();
  });
  it("does not accept a staff-console origin", async () => {
    m.rows.agent_runs[0].payload = { ...root.payload, origin: "staff_console" };
    expect((await invoke(child)).is_error).toBe(true); expect(m.open).not.toHaveBeenCalled();
  });
  it("requires the owner's/admin's role", async () => {
    role = "member";
    expect((await invoke(root)).is_error).toBe(true); expect(m.open).not.toHaveBeenCalled();
  });
  it("does not let the age-blind founder marker authorize an expired paid request", async () => {
    m.rows.agent_thread_messages[0].created_at = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect((await invoke(root)).is_error).toBe(true); expect(m.open).not.toHaveBeenCalled();
  });
});
