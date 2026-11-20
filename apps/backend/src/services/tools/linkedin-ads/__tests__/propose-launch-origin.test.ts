import { describe, expect, it, vi } from "vitest";

const summary = vi.hoisted(() => ({ status: "PAUSED" as string }));
const filing = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => null as string | null));
vi.mock("@/services/ads-wallet/linkedin-launch", async (orig) => ({
  ...((await orig()) as object),
  linkedinLaunchSummary: async () => ({ snapshot: "snap-1", name: "Spring", currency: "USD", fx: null, status: summary.status }),
  linkedinLaunchFilingRefusal: filing,
  linkedinRelaunchSpentCents: async () => null,
}));
vi.mock("@/services/ads-wallet/fx", () => ({ adsUsd: (n: number) => n }));
const asked = vi.fn(async (_ctx: { run_id?: string }) => null);
const words = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({ text: "launch it", plan: null, asked_daily_usd: null, line: null, refuse: null })));
vi.mock("@/services/approvals/approval-envelope", () => ({ founderAskFor: (ctx: { run_id?: string }) => asked(ctx), founderOrderWordsFor: words }));
vi.mock("@/services/approvals/chat-card-attach", () => ({ attachCardToChat: async () => ({ shown: true }) }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: async () => ({ data: null, error: null }),
  tenantClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const k of ["select", "eq", "order", "range", "in"]) q[k] = () => q;
      q.then = (ok: (v: unknown) => void) => ok({ data: [], error: null });
      q.maybeSingle = async () => ({ data: null, error: null });
      return q;
    },
  }),
}));
const emit = vi.fn(async (_cls: string, _body: Record<string, unknown>) => "act-1");
vi.mock("@/services/tools/linkedin-ads/_exec-action", async (orig) => ({
  ...((await orig()) as object),
  resolveLinkedInAdsEmit: async () => emit,
}));

import { callLinkedinAdsTool } from "@/services/mcp/internal/linkedin-ads";

const INPUT = {
  campaign_binding_id: "11111111-1111-4111-8111-111111111111",
  total_budget_cents: 10_000,
  end_time: Date.now() + 7 * 86_400_000,
  rationale: "Test the ops-lead audience.",
  fit_verdict: "here",
};

async function originFor(ctx: Record<string, unknown>): Promise<unknown> {
  emit.mockClear();
  const r = await callLinkedinAdsTool({ tenant_id: "t-1", run_id: "run-1", ...ctx }, "propose_launch_campaign", INPUT);
  expect(r.ok).toBe(true);
  return emit.mock.calls[0][1].origin;
}

describe("linkedin_ads propose_launch_campaign origin, through the adapter", () => {
  it("a run nobody typed into is the agent's", async () => {
    expect(await originFor({ run_trigger: "manual" })).toBe("agent");
  });

  it("the founder's own chat turn is the founder's", async () => {
    expect(await originFor({ run_trigger: "chat" })).toBe("user_initiated_chat");
  });

  it("a handoff child of the founder's chat order is the founder's", async () => {
    expect(await originFor({ run_trigger: "handoff", founder_chat_order: true })).toBe("user_initiated_chat");
  });

  it("a handoff child without the server-checked marker stays the agent's", async () => {
    expect(await originFor({ run_trigger: "handoff" })).toBe("agent");
  });

  it("the run id reaches the founder-ask lookup", async () => {
    await originFor({ run_trigger: "manual" });
    expect(asked).toHaveBeenLastCalledWith(expect.objectContaining({ run_id: "run-1" }));
  });
});

describe("linkedin_ads propose_launch_campaign refuses at filing what the executor would refuse", () => {
  it("files no card and hands the agent the executor's own reason", async () => {
    emit.mockClear();
    filing.mockResolvedValueOnce("LinkedIn reports that the advertiser account is not ready to serve.");
    const r = await callLinkedinAdsTool({ tenant_id: "t-1", run_id: "run-1", run_trigger: "manual" }, "propose_launch_campaign", INPUT);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("Nothing was proposed: LinkedIn reports that the advertiser account is not ready to serve.");
    expect(emit).not.toHaveBeenCalled();
  });

  it("checks the total and end the card will carry, after a founder's ask replaced them", async () => {
    emit.mockClear();
    filing.mockClear();
    asked.mockResolvedValueOnce({ line: "Line.", source: "ask", plan: { total_usd: 250, days: 5, budget_type: "lifetime" } } as never);
    const r = await callLinkedinAdsTool({ tenant_id: "t-1", run_id: "run-1", run_trigger: "chat" }, "propose_launch_campaign", INPUT);
    expect(r.ok).toBe(true);
    const checked = filing.mock.calls[0]![2] as { total_budget_cents: number; end_time: number };
    expect(checked.total_budget_cents).toBe(25_000);
    expect(checked.end_time).toBe((emit.mock.calls[0]![1] as { end_time: number }).end_time);
    expect(checked.end_time).not.toBe(INPUT.end_time);
  });
});

describe("linkedin_ads propose_launch_campaign files only on a go verdict and a paused campaign", () => {
  const call = (ctx: Record<string, unknown>, input: Record<string, unknown>) =>
    callLinkedinAdsTool({ tenant_id: "t-1", run_id: "run-1", ...ctx }, "propose_launch_campaign", input);

  it.each([["not_here"], ["unsure"], [undefined]])("an agent's own run with verdict %s files nothing", async (fit_verdict) => {
    emit.mockClear();
    summary.status = "PAUSED";
    const r = await call({ run_trigger: "manual" }, { ...INPUT, fit_verdict });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("only on a go verdict");
    expect(emit).not.toHaveBeenCalled();
  });

  it("a founder's own chat order is not held to the run's verdict", async () => {
    emit.mockClear();
    summary.status = "PAUSED";
    const r = await call({ run_trigger: "chat" }, { ...INPUT, fit_verdict: undefined });
    expect(r.ok).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it.each([["ACTIVE"], ["ARCHIVED"], ["DRAFT"]])("a go verdict on a %s campaign files nothing", async (status) => {
    emit.mockClear();
    summary.status = status;
    const r = await call({ run_trigger: "manual" }, INPUT);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("only a paused bound LinkedIn campaign");
    expect(emit).not.toHaveBeenCalled();
    summary.status = "PAUSED";
  });

  it("the verdict never reaches the stored launch body", async () => {
    emit.mockClear();
    summary.status = "PAUSED";
    await call({ run_trigger: "manual" }, INPUT);
    expect(emit.mock.calls[0][1]).not.toHaveProperty("fit_verdict");
  });
});

describe("the MCP adapter carries the unverified founder mark to the pause gate", () => {
  it("a founder mark that could not be verified never lifts the pause_candidate rule", async () => {
    const tool = await import("../propose_pause_campaign");
    const execute = vi.spyOn(tool.linkedinAdsProposePauseCampaignTool, "execute").mockResolvedValue({ ok: true } as never);
    await callLinkedinAdsTool({ tenant_id: "t-1", run_id: "run-1", run_trigger: "handoff", founder_chat_order: true, founder_order_unverified: true }, "propose_pause_campaign", { campaign_id: "22", account_id: "11", rationale: "Stop it." });
    expect(execute.mock.calls[0]![0]).toMatchObject({ founder_chat_order: true, founder_order_unverified: true });
    execute.mockRestore();
  });
});
