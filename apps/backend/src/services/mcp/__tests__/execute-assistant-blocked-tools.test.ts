import { describe, it, expect, vi } from "vitest";

const govern = vi.fn(async () => ({ block: false }));
const report = vi.fn(async () => ({ ok: true, is_error: false, content: "{}", ms: 0 }));
vi.mock("../governance-enforce", () => ({ governActionOrBlock: (...a: unknown[]) => govern(...(a as [])) }));
vi.mock("../discovery", () => ({ getEnabledStreamableServer: async () => null }));
vi.mock("../streamable-client", () => ({ callStreamableTool: vi.fn(), advertisedReadToolNames: () => new Set() }));
vi.mock("../internal/praxis", () => ({ callPraxisTool: vi.fn(), listPraxisTools: () => [] }));
vi.mock("../internal/report", () => ({
  callReportTool: (...a: unknown[]) => report(...(a as [])),
  listReportTools: () => [],
}));
vi.mock("@/services/routines/runner", () => ({ runTenantRoutine: vi.fn(), defaultDeps: {} }));
vi.mock("@/services/agents/skill-runtime", () => ({ handleSkillLoad: vi.fn() }));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));

import { callMcpTool, type CallMcpContext } from "../execute";

const ctx = (trigger: string) => ({ tenant_id: "T1", run_id: "R1", agent_slug: "operator", trigger }) as CallMcpContext;

describe("callMcpTool on a run started from an AI assistant", () => {
  it.each([
    ["report", "generate_image"],
    ["report", "render_social_image"],
    ["generated_video", "propose"],
    ["praxis", "render_video"],
    ["praxis", "render_launch_video"],
    ["higgsfield", "generate_video"],
    ["stripe", "create_payment"],
    ["stripe", "remit_to_tenant"],
  ])("refuses %s/%s before governance or dispatch", async (server, tool) => {
    govern.mockClear();
    report.mockClear();
    const r = await callMcpTool(ctx("mcp"), server, tool, {});
    expect(r.is_error).toBe(true);
    expect(JSON.parse(r.content).error).toBe("not_available_from_assistant");
    expect(govern).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("still renders a PDF, without its AI photo prompts", async () => {
    report.mockClear();
    const r = await callMcpTool(ctx("mcp"), "report", "render_pdf", {
      title: "Plan",
      sections: [{ heading: "A", body: "x", image_concept: "a bike shop at dawn" }],
    });
    expect(r.is_error).toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]).toEqual([
      expect.anything(),
      "render_pdf",
      { title: "Plan", sections: [{ heading: "A", body: "x" }] },
    ]);
  });

  it("control: a chat run reaches the image tool with its args intact", async () => {
    report.mockClear();
    await callMcpTool(ctx("chat"), "report", "generate_image", { prompt: "a bike" });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]).toEqual([expect.anything(), "generate_image", { prompt: "a bike" }]);
  });

  it("turns a purchase-prompting refusal into an informational one", async () => {
    report.mockResolvedValueOnce({
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "plan_upgrade_required",
        required_tier: "pro",
        message: "Meta Ads needs the Pro plan ($240/mo). Tell the user they can upgrade on the Billing page.",
        action: "upgrade",
      }),
      ms: 0,
    });
    const r = await callMcpTool(ctx("mcp"), "report", "render_pdf", {});
    const body = JSON.parse(r.content);
    expect(body.error).toBe("plan_upgrade_required");
    expect(body.message).not.toMatch(/upgrade|\$|billing/i);
    expect(body.action).toBeUndefined();
  });

  it("control: a chat run keeps the refusal as written", async () => {
    const content = JSON.stringify({ code: "insufficient_credits", message: "Top up in Billing." });
    report.mockResolvedValueOnce({ ok: false, is_error: true, content, ms: 0 });
    const r = await callMcpTool(ctx("chat"), "report", "render_pdf", {});
    expect(r.content).toBe(content);
  });

  it("turns a purchase-related error thrown by a nested enqueue into a refusal", async () => {
    const e = new Error('Agent "seo" rejected: out of credits — top up to keep running');
    e.name = "InsufficientCreditsError";
    report.mockRejectedValueOnce(e);
    const r = await callMcpTool(ctx("mcp"), "report", "render_pdf", {});
    expect(r.is_error).toBe(true);
    const body = JSON.parse(r.content);
    expect(body.error).toBe("insufficient_credits");
    expect(body.message).not.toMatch(/top up/i);
  });

  it("rethrows any other error, and every error on a chat run", async () => {
    report.mockRejectedValueOnce(new Error("boom"));
    await expect(callMcpTool(ctx("mcp"), "report", "render_pdf", {})).rejects.toThrow("boom");
    const e = new Error("out of credits — top up");
    e.name = "InsufficientCreditsError";
    report.mockRejectedValueOnce(e);
    await expect(callMcpTool(ctx("chat"), "report", "render_pdf", {})).rejects.toThrow("top up");
  });
});
