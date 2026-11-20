
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn().mockResolvedValue({ data: true, error: null }),
}));
vi.mock("@/services/channels/lock", () => ({
  isChannelLocked: async () => false,
  comingSoonMessage: (name: string) => `${name} is coming soon.`,
}));

vi.mock("@/services/channels/budget", () => ({
  CAP_REACHED_MESSAGE: "cap reached",
}));
vi.mock("@/services/channels/claim", () => ({
  claimChannelRun: vi.fn().mockResolvedValue({ kind: "claimed", claim_id: "claim-redo-1" }),
  settleChannelRunClaim: vi.fn().mockResolvedValue(undefined),
  releaseChannelRunClaim: vi.fn().mockResolvedValue(undefined),
}));

import { runChannelRecipe } from "@/services/channels/engine";

const enqueue = vi.fn();
const deps = { enqueue };

beforeEach(() => {
  vi.clearAllMocks();
  enqueue.mockResolvedValue({ run_id: "run-redo-1" });
});

const REDO = {
  action_key: "794fbd95694815b5",
  action_title: "Add an H1 to the homepage",
  note: "we are a marketplace, not a SaaS",
};

describe("runChannelRecipe — redo", () => {
  it("carries the redo into the payload the model actually sees", async () => {
    const out = await runChannelRecipe("t-1", "seo", deps, REDO);
    expect(out.ok).toBe(true);
    const payload = enqueue.mock.calls[0][0].payload;
    expect(payload.redo).toEqual(REDO);
  });

  it("carries an answer redo's kind to the model", async () => {
    await runChannelRecipe("t-1", "seo", deps, { ...REDO, kind: "answer" });
    expect(enqueue.mock.calls[0][0].payload.redo.kind).toBe("answer");
  });

  it("runs as a CHANNEL run, which is what makes the visibility gates pass", async () => {
    await runChannelRecipe("t-1", "seo", deps, REDO);
    expect(enqueue.mock.calls[0][0].trigger).toBe("channel_recipe");
  });

  it("still sends the recipe and the router, so the rewrite is still grounded", async () => {
    await runChannelRecipe("t-1", "seo", deps, REDO);
    const payload = enqueue.mock.calls[0][0].payload;
    expect(payload.channel_slug).toBe("seo");
    expect(payload.recipe_body).toBeTruthy();
    expect(payload.router).toBeTruthy();
  });

  it("omits redo entirely on a normal run", async () => {
    await runChannelRecipe("t-1", "seo", deps);
    const payload = enqueue.mock.calls[0][0].payload;
    expect("redo" in payload).toBe(false);
  });

  it("refuses an unknown channel before enqueuing anything", async () => {
    const out = await runChannelRecipe("t-1", "not-a-channel", deps, REDO);
    expect(out.ok).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("the recipe tells the agent what redo means", () => {
  it("asks for exactly ONE rewritten step, not a fresh punch list", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const base = readFileSync(
      join(__dirname, "../../../channels/_base/recipe-base.md"),
      "utf8",
    );
    expect(base).toMatch(/Produce exactly ONE step/);
    expect(base).toMatch(/redo/);
    expect(base).toMatch(/Keep the evidence honest/);
  });
});
