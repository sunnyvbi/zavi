import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ row: vi.fn(), eq: vi.fn(), tenant: vi.fn(), message: vi.fn(), open: vi.fn(), lookup: vi.fn(), claim: vi.fn(), commit: vi.fn(), release: vi.fn(), send: vi.fn() }));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<object>()),
  asTenantId: (id: string) => id,
  tenantClient: (id: string) => {
    m.tenant(id);
    const q = { select: () => q, eq: (...args: unknown[]) => (m.eq(...args), q), maybeSingle: m.row };
    return { from: () => q };
  },
}));
vi.mock("@/services/approvals/founder-message", () => ({ founderMessageOf: m.message }));
vi.mock("@/services/tools/growth/geo/visibility/sweep", () => ({ openSweep: m.open }));
vi.mock("@/../workers/client", () => ({ inngest: { send: m.send } }));
vi.mock("@/services/mcp/tool-effect-ledger", async (orig) => ({
  ...(await orig<object>()),
  realToolEffectDeps: { lookupCommitted: m.lookup, claimPending: m.claim, commit: m.commit, release: m.release },
}));
vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig));
import { callGeoTool, listGeoTools, type GeoToolCtx } from "@/services/mcp/internal/geo";
import { resetTenantPlan, tenantPlan } from "@/__tests__/helpers/tenant-plan";
import { hashToolInput } from "@/services/mcp/tool-effect-ledger";
const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ctx: GeoToolCtx = { tenant_id: TENANT, run_id: "child-run", run_trigger: "chat", founder_chat_order: true };
const started = { ok: true, sweep_id: "sweep-1", country: "US", planned: 60, used_7d: 0, cap_7d: 600, runner: "worker" };
const call = (over: Partial<GeoToolCtx> = {}, input = {}) => callGeoTool({ ...ctx, ...over }, "start_answer_check", input);
const body = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.content);
beforeEach(() => {
  vi.resetAllMocks(); resetTenantPlan(); tenantPlan.tier = "starter";
  m.row.mockResolvedValue({ data: { id: "child-run", trigger: "chat", enqueued_by: USER, payload: {} }, error: null });
  m.message.mockResolvedValue({ author_user_id: USER, text: "Run the AI-answer check", ref: { run_id: "root-run", kind: "chat" } });
  m.open.mockResolvedValue(started); m.lookup.mockResolvedValue(null); m.claim.mockResolvedValue(true);
});
describe("GEO answer-check capability", () => {
  it("exposes an explicit paid start separately from the visibility reader", () => {
    expect(listGeoTools()).toContainEqual(expect.objectContaining({ server_id: "geo", tool_name: "start_answer_check", effect: "money" }));
  });
  it.each(["chat", "handoff", "slack"])("starts from verified %s provenance and returns a start receipt", async (trigger) => {
    const result = body(await call({ run_trigger: trigger, chat_answer_turn: true }));
    expect(result).toMatchObject({ sweep_id: "sweep-1", status: "started", planned: 60 });
    expect(result).not.toHaveProperty("mention_rate");
    expect(m.open).toHaveBeenCalledWith(TENANT, { requestedBy: USER, country: null }, { send: expect.any(Function) });
    expect(m.tenant).toHaveBeenCalledWith(TENANT);
    expect(m.eq).toHaveBeenCalledWith("tenant_id", TENANT);
    expect(m.eq).toHaveBeenCalledWith("id", "child-run");
    expect(m.message).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, id: "child-run" }), { strict: true });
    expect(m.claim).toHaveBeenCalledWith(expect.objectContaining({ run_id: "root-run", takeover: false }));
    await m.open.mock.calls[0][2].send({ name: "geo.prompt_sweep.requested", data: { tenant_id: TENANT, sweep_id: "sweep-1" } });
    expect(m.send).toHaveBeenCalledOnce();
  });
  it("uses the resolved Zavi user for Slack, not a Slack identifier", async () => {
    m.message.mockResolvedValue({ author_user_id: USER, ref: { run_id: "root-run", kind: "slack", author_user_id: "U123" } });
    await call({ run_trigger: "slack" });
    expect(m.open.mock.calls[0][1].requestedBy).toBe(USER);
  });
  it.each([
    { run_id: undefined }, { founder_chat_order: false }, { founder_order_unverified: true },
    { writes_suppressed: true }, { redo: true }, { untrusted_context: true }, { captured_page_context: true },
    ...["cron", "manual", "mcp", "email", "webhook", "a2a"].map(run_trigger => ({ run_trigger })),
  ])("refuses non-human or suppressed execution: %j", async (over) => {
    expect(body(await call(over)).error).toBe("founder_request_required");
    expect(m.open).not.toHaveBeenCalled(); expect(m.claim).not.toHaveBeenCalled();
  });
  it.each([null, { author_user_id: null, ref: { run_id: "root-run" } }])("refuses a missing/expired original message: %j", async (message) => {
    m.message.mockResolvedValue(message);
    expect(body(await call()).error).toBe("founder_request_required"); expect(m.open).not.toHaveBeenCalled();
  });
  it("refuses an unreadable or foreign run", async () => {
    m.row.mockResolvedValue({ data: null, error: null });
    expect(body(await call()).error).toBe("request_unreadable");
    expect(m.message).not.toHaveBeenCalled(); expect(m.open).not.toHaveBeenCalled();
  });
  it("does not accept tenant, user or confirmation arguments from the model", async () => {
    await expect(call({}, { tenant_id: "foreign", requestedBy: USER, confirmed: true })).rejects.toThrow();
    expect(m.open).not.toHaveBeenCalled();
  });
  it.each(["free", "unreadable"])("reuses the actual %s plan refusal before admission", async (plan) => {
    if (plan === "free") tenantPlan.tier = "free"; else tenantPlan.unreadable = true;
    expect(body(await call()).error).toBe("plan_upgrade_required");
    expect(m.open).not.toHaveBeenCalled(); expect(m.claim).not.toHaveBeenCalled();
  });
  it.each(["disabled", "not_configured", "no_prompts", "already_running", "tenant_cap_reached", "tenant_limit_reached", "fleet_cap_reached"])("preserves %s without inventing a start", async (reason) => {
    m.open.mockResolvedValue({ ok: false, reason, message: "Provider refusal", used_7d: 12 });
    expect(body(await call())).toMatchObject({ ok: false, reason, status: "not_started", used_7d: 12 });
    expect(m.release).toHaveBeenCalledOnce(); expect(m.commit).not.toHaveBeenCalled();
  });
  it("keeps uncertain sends claimed", async () => {
    m.open.mockResolvedValue({ ok: false, reason: "unavailable", message: "Start unconfirmed" });
    expect(body(await call())).toMatchObject({ status: "unknown", reason: "unavailable" });
    expect(m.release).not.toHaveBeenCalled(); expect(m.commit).toHaveBeenCalledOnce();
  });
  it("replays the receipt for the same human turn, including a sibling handoff", async () => {
    const first = await call();
    m.lookup.mockResolvedValue({ input_hash: hashToolInput({}), result: first });
    expect(await call({ run_id: "sibling", run_trigger: "handoff" })).toMatchObject({ content: first.content });
    expect(m.open).toHaveBeenCalledOnce();
  });
  it("does not spend again for a changed country on the same request", async () => {
    const first = await call(); m.lookup.mockResolvedValue({ input_hash: hashToolInput({}), result: first });
    expect(body(await call({}, { country: "CA" })).error).toBe("check_already_requested");
    expect(m.open).toHaveBeenCalledOnce();
  });
  it.each([false, "stale"])("does not take over a %s claim", async (claim) => {
    m.claim.mockResolvedValue(claim);
    expect(body(await call()).error).toBe("check_request_pending"); expect(m.open).not.toHaveBeenCalled();
  });
  it.each(["lookup", "claim", "message"] as const)("does not spend if %s fails", async (read) => {
    m[read].mockRejectedValue(new Error("unavailable"));
    expect(body(await call()).error).toBe("check_start_unconfirmed"); expect(m.open).not.toHaveBeenCalled();
  });
  it("admits only one concurrent call for the same original request", async () => {
    m.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const results = await Promise.all([call(), call()]);
    expect(m.open).toHaveBeenCalledOnce();
    expect(results.filter(r => r.is_error)).toHaveLength(1);
  });
  it("keeps the pending claim if saving a receipt fails", async () => {
    m.commit.mockRejectedValue(new Error("write unavailable"));
    expect(body(await call()).error).toBe("check_start_unconfirmed"); expect(m.release).not.toHaveBeenCalled();
  });
});
