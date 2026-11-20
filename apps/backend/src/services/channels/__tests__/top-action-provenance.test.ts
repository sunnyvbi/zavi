
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({ isMetaAdsWriteEnabled: async () => true }));

import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import { metaProposeNewAdTool } from "@/services/tools/meta-ads/write/propose_launch";
import type { ToolContext } from "@/services/tools/types";

const input = {
  ad_set_id: "2220001",
  primary_text: "Teslas for Halloween",
  headline: "Book now",
  link_url: "https://upcar.ai/halloween",
  image_url: "https://x.example/i.png",
  source: "zavi_generated",
  rationale: "Adds 3 ads to the running traffic ad set.",
};

function ctx(extra: Partial<ToolContext>) {
  const emit = vi.fn(async (_c: string, _b: unknown) => "d-1");
  const c: ToolContext = { tenant_id: "t-1", log: () => {}, emit_decision: emit, run_trigger: "channel_recipe", ...extra };
  return { c, emit };
}

describe("top-action provenance", () => {
  it("isHumanAuthoredCommand is true for a top-action run, even when rules steered", () => {
    expect(isHumanAuthoredCommand({ run_trigger: "channel_recipe", top_action_run: true })).toBe(true);
    expect(isHumanAuthoredCommand({ run_trigger: "channel_recipe", top_action_run: true, rules_steered: { budget: true, status: true } }, "budget")).toBe(true);
    expect(isHumanAuthoredCommand({ run_trigger: "channel_recipe" })).toBe(false);
  });

  it("a top-action run's new ad carries the human origin", async () => {
    const a = ctx({ top_action_run: true });
    await metaProposeNewAdTool.execute(a.c, input);
    expect((a.emit.mock.calls[0][1] as { origin?: string }).origin).toBe("user_initiated_chat");
  });

  it("a normal channel run's new ad does not", async () => {
    const a = ctx({});
    await metaProposeNewAdTool.execute(a.c, input);
    expect((a.emit.mock.calls[0][1] as { origin?: string }).origin).toBeUndefined();
  });
});
