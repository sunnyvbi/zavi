
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const stopState = vi.hoisted(() => ({ value: false as boolean | null }));
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => stopState.value }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: (t: string, n: string, a: Record<string, unknown>) => rpc(t, n, a),
}));

const claim = vi.fn();
const settle = vi.fn();
const release = vi.fn();
vi.mock("@/services/channels/lock", () => ({
  isChannelLocked: async () => false,
  comingSoonMessage: (name: string) => `${name} is coming soon.`,
}));

vi.mock("@/services/channels/budget", () => ({
  CAP_REACHED_MESSAGE: "cap reached",
}));

vi.mock("@/services/channels/claim", () => ({
  claimChannelRun: (...a: unknown[]) => claim(...a),
  settleChannelRunClaim: (...a: unknown[]) => settle(...a),
  releaseChannelRunClaim: (...a: unknown[]) => release(...a),
}));

import { runChannelRecipe } from "@/services/channels/engine";
import { loadChannelRecipe } from "@/services/channels/recipe";

const TID = "33333333-3333-3333-3333-333333333333";
const enqueue = vi.fn();
const deps = { enqueue };

beforeEach(() => {
  rpc.mockReset();
  claim.mockReset();
  settle.mockReset();
  release.mockReset();
  enqueue.mockReset();
  rpc.mockResolvedValue({ data: true, error: null });
  enqueue.mockResolvedValue({ run_id: "run-1" });
  claim.mockResolvedValue({ kind: "claimed", claim_id: "claim-1" });
  settle.mockResolvedValue(undefined);
  release.mockResolvedValue(undefined);
  stopState.value = false;
});

describe("refusals", () => {
  it("refuses an unknown channel without touching admission or enqueue", async () => {
    const r = await runChannelRecipe(TID, "not_a_channel", deps);
    expect(r).toMatchObject({ ok: false, reason: "unknown_channel" });
    expect(claim).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a real channel whose recipe file is missing", async () => {
    const recipeMod = await import("../recipe");
    const spy = vi.spyOn(recipeMod, "recipeExists").mockReturnValue(false);
    try {
      const r = await runChannelRecipe(TID, "tiktok_ads", deps);
      expect(r).toMatchObject({ ok: false, reason: "no_recipe" });
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses at the cap WITHOUT enqueuing — no credits reserved", async () => {
    claim.mockResolvedValue({ kind: "cap_reached", spent_30d: 2000 });
    const r = await runChannelRecipe(TID, "meta_ads", deps);
    expect(r).toMatchObject({ ok: false, reason: "cap_reached", spent_30d: 2000 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a channel the founder stopped before any claim, and an unreadable stop too (Growth J6)", async () => {
    for (const value of [true, null]) {
      stopState.value = value;
      const r = await runChannelRecipe(TID, "meta_ads", deps, undefined, { standing_order: "x" });
      expect(r).toMatchObject({ ok: false, reason: "founder_stopped" });
    }
    expect(claim).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses when the budget is unreadable, and does not enqueue", async () => {
    claim.mockResolvedValue({ kind: "unavailable" });
    const r = await runChannelRecipe(TID, "meta_ads", deps);
    expect(r).toMatchObject({ ok: false, reason: "budget_unavailable" });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("dispatch", () => {
  it("is ADMITTED before it is enqueued — no credits reserved on a refusal", async () => {
    const order: string[] = [];
    claim.mockImplementation(async () => {
      order.push("admit");
      return { kind: "claimed", claim_id: "claim-1" };
    });
    enqueue.mockImplementation(async () => {
      order.push("enqueue");
      return { run_id: "run-1" };
    });
    await runChannelRecipe(TID, "meta_ads", deps);
    expect(order).toEqual(["admit", "enqueue"]);
  });

  it("dispatches to the channel's registry executor", async () => {
    await runChannelRecipe(TID, "meta_ads", deps);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      slug: "meta_ads",
      tenant_id: TID,
      trigger: "channel_recipe",
    });
  });

  it("sends the MERGED recipe body, base rules included", async () => {
    await runChannelRecipe(TID, "meta_ads", deps);
    const body = enqueue.mock.calls[0][0].payload.recipe_body as string;
    expect(body).toContain("model_assertion");
    expect(body).toContain("# Meta Ads");
  });

  it("stamps the channel durably, separately from the payload copy", async () => {
    const r = await runChannelRecipe(TID, "meta_ads", deps);
    expect(r).toMatchObject({ ok: true, run_id: "run-1", stamped: true });
    const call = rpc.mock.calls.find((c) => c[1] === "stamp_channel_run");
    expect(call?.[2]).toEqual({ p_run_id: "run-1", p_channel_slug: "meta_ads" });
    expect(call?.[2]).not.toHaveProperty("p_tenant_id");
  });

  it("still reports the run when stamping fails — the run exists either way", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const r = await runChannelRecipe(TID, "meta_ads", deps);
    expect(r).toMatchObject({ ok: true, run_id: "run-1", stamped: false });
  });
});

describe("the payload carries the recipe's router", () => {
  it("sends seo's router steps to the model", async () => {
    const r = await runChannelRecipe(TID, "seo", deps);
    expect(r).toMatchObject({ ok: true });

    const payload = enqueue.mock.calls[0][0].payload as {
      router?: Array<{ id: string }>;
    };
    const ids = (payload.router ?? []).map((s) => s.id);
    expect(ids).toEqual([
        "indexability",
        "page_claims",
        "organic_performance",
        "search_performance",
        "competitor_serp",
        "rank_findings",
        "proof_page",
      ]);
  });

  it("sends geo's router steps to the model", async () => {
    const r = await runChannelRecipe(TID, "geo", deps);
    expect(r).toMatchObject({ ok: true });
    expect(enqueue.mock.calls.at(-1)![0].slug).toBe("geo");

    const payload = enqueue.mock.calls.at(-1)![0].payload as {
      router?: Array<{ id: string }>;
    };
    expect((payload.router ?? []).map((s) => s.id)).toEqual([
      "ai_crawler_access",
      "structured_data",
      "answer_shape",
      "entity_presence",
      "offsite_opportunity",
      "rank_findings",
      "answer_brief",
    ]);
  });

  it("seo and geo share no analysis step — a moved step is not a copied step", () => {
    const stepIds = (slug: string) =>
      new Set(loadChannelRecipe(slug).meta.router.map((s) => s.id));
    const seo = stepIds("seo");
    const geo = stepIds("geo");
    const shared = [...geo].filter((id) => seo.has(id));
    expect(shared).toEqual(["rank_findings"]);
  });

  it("the router is NOT already in recipe_body — this is why it must be passed", () => {
    const payload = enqueue.mock.calls[0]?.[0]?.payload as
      | { recipe_body?: string }
      | undefined;
    expect(payload?.recipe_body ?? "").not.toContain("competitor_serp");
  });
});

describe("extra payload keys", () => {
  it("adds extra keys next to the recipe's own", async () => {
    const so = { prompt: "daily brief", deliver: { kind: "chat_thread", thread_id: "t" } };
    await runChannelRecipe(TID, "x_organic", deps, undefined, { standing_order: so });
    const payload = enqueue.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.standing_order).toEqual(so);
    expect(payload.channel_slug).toBe("x_organic");
    expect(Array.isArray(payload.router)).toBe(true);
  });

  it("never lets extra override a recipe key", async () => {
    await runChannelRecipe(TID, "x_organic", deps, undefined, {
      router: [{ id: "forged" }],
      recipe_body: "forged",
      channel_slug: "meta_ads",
    });
    const payload = enqueue.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.channel_slug).toBe("x_organic");
    expect(payload.recipe_body).not.toBe("forged");
    const ids = (payload.router as Array<{ id: string }>).map((s) => s.id);
    expect(ids).not.toContain("forged");
    expect(ids).toContain("presence");
  });

  it("must catch: an email_plan key in extra (a schedule template, any caller) is dropped; only the server argument sets the mode", async () => {
    const forged = { mode: "planned_draft", item_id: "11111111-1111-4111-8111-111111111111", version: 1 };
    await runChannelRecipe(TID, "email_marketing", deps, undefined, { email_plan: forged, standing_order: { prompt: "x" } });
    const first = enqueue.mock.calls[0][0].payload as Record<string, unknown>;
    expect(first).not.toHaveProperty("email_plan");
    expect(first).toHaveProperty("standing_order");
    const real = { mode: "weekly_plan", timezone: "UTC", week_of: "2026-10-19" };
    await runChannelRecipe(TID, "email_marketing", deps, undefined, { email_plan: forged }, "req-12345678", real);
    expect((enqueue.mock.calls[1][0].payload as Record<string, unknown>).email_plan).toEqual(real);
  });

  it("absent extra leaves the payload byte-identical", async () => {
    await runChannelRecipe(TID, "x_organic", deps);
    const payload = enqueue.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("standing_order");
  });
});
