import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), rpc: vi.fn() }));
vi.mock("../business-control-policy", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readBusinessPolicy: mocks.read,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: mocks.rpc,
  tenantClient: vi.fn(),
}));
import { proposeBusinessControlsTool } from "@/services/tools/growth/business_controls";
import { callGrowthTool } from "@/services/mcp/internal/growth";
import { approveBusinessControls } from "../business-control-proposal";
import { BUSINESS_CONTROL_DEFAULTS } from "../business-control-policy";
import { buildInlineDecisionBody } from "@/services/agents/build-inline-decision";
const policy = {
  ...BUSINESS_CONTROL_DEFAULTS,
  enabled: true,
  max_cpa_usd: 75,
  min_spend_usd: 150,
};
const id = "33333333-3333-4333-8333-333333333333";
const ctx = {
  run_trigger: "chat" as const,
  tenant_id: "t",
  run_id: "r",
  log: vi.fn(),
  emit_decision: vi.fn(async (_cls: string, _body: unknown) => id),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue(null);
});
it("proposes all recommended values without saving, returning a renderable card", async () => {
  const out = await proposeBusinessControlsTool.execute(ctx, {
    policy,
    rationale: "Suggested starting limits, not measured profit.",
  });
  expect(out).toMatchObject({
    decision_id: id,
    saved: false,
    status: "pending_approval",
  });
  expect(ctx.emit_decision).toHaveBeenCalledWith(
    "growth.save_business_controls",
    {
      policy,
      revision: 0,
      previous_policy: null,
      rationale: "Suggested starting limits, not measured profit.",
    },
  );
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(
    buildInlineDecisionBody({
      decision_id: id,
      decision_class: "growth.save_business_controls",
      body: {},
    }),
  ).toMatchObject({ title: "Business results and experiments" });
});
it("captures the saved revision, not a model-supplied revision", async () => {
  mocks.read.mockResolvedValue({
    ...policy,
    revision: 4,
    updated_at: "2026-10-12",
  });
  await proposeBusinessControlsTool.execute(ctx, {
    policy,
    rationale: "Change the limits.",
  });
  expect(ctx.emit_decision.mock.calls[0]?.[1]).toMatchObject({
    revision: 4,
    previous_policy: policy,
  });
  await expect(
    proposeBusinessControlsTool.execute(ctx, {
      policy,
      rationale: "x",
      revision: 999,
    }),
  ).rejects.toThrow();
});
it("refuses shadow/draft runs and invalid limits without creating cards", async () => {
  await expect(
    proposeBusinessControlsTool.execute(
      { ...ctx, writes_suppressed: true },
      { policy, rationale: "x" },
    ),
  ).rejects.toThrow();
  await expect(
    proposeBusinessControlsTool.execute(ctx, {
      policy: { ...policy, max_cpa_usd: -1 },
      rationale: "x",
    }),
  ).rejects.toThrow();
  expect(ctx.emit_decision).not.toHaveBeenCalled();
});
it("the real Growth MCP wrapper forwards the decision emitter", async () => {
  const result = await callGrowthTool(
    "t",
    "propose_business_controls",
    { policy, rationale: "Suggested limits." },
    "r",
    { run_trigger: "chat", emit_decision: ctx.emit_decision },
  );
  expect(result.ok).toBe(true);
  expect(ctx.emit_decision).toHaveBeenCalled();
});
it("only schema-valid edited settings reach the tenant RPC", async () => {
  expect(await approveBusinessControls("t", "u", id, {})).toEqual({
    status: "invalid_edit",
  });
  expect(mocks.rpc).not.toHaveBeenCalled();
  mocks.rpc.mockResolvedValue({ data: { status: "saved", changed: true } });
  await approveBusinessControls("t", "u", id, {
    policy,
    expected_policy: policy,
    revision: 0,
  });
  expect(mocks.rpc).toHaveBeenCalledWith(
    "t",
    "approve_growth_business_controls",
    expect.objectContaining({ p_actor: "u", p_policy: policy, p_revision: 0 }),
  );
});

it.each([
  { run_trigger: "cron" },
  { run_trigger: "chat", untrusted_context: true },
  { run_trigger: "chat", captured_page_context: true },
])("refuses non-human proposal origins: %j", async (origin) => {
  await expect(
    proposeBusinessControlsTool.execute(
      { ...ctx, ...origin },
      { policy, rationale: "Set limits." },
    ),
  ).rejects.toThrow();
  expect(ctx.emit_decision).not.toHaveBeenCalled();
});
