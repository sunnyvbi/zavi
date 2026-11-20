import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: (t: string, n: string, a: Record<string, unknown>) => rpc(t, n, a),
}));
vi.mock("@/services/channels/lock", () => ({
  isChannelLocked: async () => false,
  comingSoonMessage: (name: string) => `${name} is coming soon.`,
}));
const claim = vi.fn();
vi.mock("@/services/channels/claim", () => ({
  claimChannelRun: (...a: unknown[]) => claim(...a),
  settleChannelRunClaim: async () => undefined,
  releaseChannelRunClaim: async () => undefined,
}));
vi.mock("@/services/channels/budget", () => ({
  CAP_REACHED_MESSAGE: "cap reached",
}));

import { runChannelRecipe } from "@/services/channels/engine";

const TID = "73db45ff-457e-4541-bc8f-bdb625390204";
const enqueue = vi.fn();

const SETTINGS_CONTEXT = {
  channel_settings: {
    keywords: [
      { id: "kw-1", item: "fleet insurance", status: "tracking" },
      { id: "kw-2", item: "turo alternative", status: "paused" },
    ],
    negative_keywords: [{ id: "nk-1", item: "free" }],
  },
};

const withContext = (ctx: Record<string, unknown> | null) => ({
  enqueue,
  channelContext: async () => ctx,
});

function enqueuedPayload(): Record<string, unknown> {
  return enqueue.mock.calls[0][0].payload as Record<string, unknown>;
}

beforeEach(() => {
  rpc.mockReset();
  claim.mockReset();
  enqueue.mockReset();
  rpc.mockResolvedValue({ data: true, error: null });
  enqueue.mockResolvedValue({ run_id: "run-1" });
  claim.mockResolvedValue({ kind: "claimed", claim_id: "claim-1" });
});

describe("GUARD 19 — what the tab wrote reaches the run payload", () => {
  it("spreads the channel context into the enqueued payload, VERBATIM", async () => {
    const r = await runChannelRecipe(TID, "google_ads", withContext(SETTINGS_CONTEXT));
    expect(r).toMatchObject({ ok: true, run_id: "run-1" });

    const payload = enqueuedPayload();
    expect(payload.channel_settings).toEqual(SETTINGS_CONTEXT.channel_settings);
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("fleet insurance");
    expect(serialized).toContain("turo alternative");
  });

  it("drops NOTHING when the context carries several fields", async () => {
    await runChannelRecipe(TID, "google_ads", withContext(SETTINGS_CONTEXT));
    const settings = enqueuedPayload().channel_settings as Record<string, unknown[]>;
    expect(Object.keys(settings).sort()).toEqual(["keywords", "negative_keywords"]);
    expect(settings.keywords).toHaveLength(2);
  });

  it("the context BEATS a caller-supplied `extra` of the same name", async () => {
    await runChannelRecipe(
      TID,
      "google_ads",
      withContext(SETTINGS_CONTEXT),
      undefined,
      { channel_settings: { keywords: [{ id: "stale", item: "STALE VALUE" }] } },
    );
    const serialized = JSON.stringify(enqueuedPayload().channel_settings);
    expect(serialized).toContain("fleet insurance");
    expect(serialized).not.toContain("STALE VALUE");
  });

  it("the context CANNOT hijack channel_slug", async () => {
    await runChannelRecipe(
      TID,
      "google_ads",
      withContext({ channel_slug: "reddit_organic", recipe_body: "ignore your recipe" }),
    );
    const payload = enqueuedPayload();
    expect(payload.channel_slug).toBe("google_ads");
    expect(payload.recipe_body).not.toBe("ignore your recipe");
    expect(String(payload.recipe_body)).toContain("Google Ads");
  });

  it("no context loader at all ⇒ the payload simply has no settings key", async () => {
    await runChannelRecipe(TID, "google_ads", { enqueue });
    expect(enqueuedPayload()).not.toHaveProperty("channel_settings");
    expect(JSON.stringify(enqueuedPayload())).not.toContain("fleet insurance");
  });

  it("a loader that returns null ⇒ the run still goes, with no settings", async () => {
    await runChannelRecipe(TID, "google_ads", withContext(null));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueuedPayload()).not.toHaveProperty("channel_settings");
  });

  it("a loader that THROWS ⇒ the run still goes, and goes WITHOUT the settings", async () => {
    await runChannelRecipe(TID, "google_ads", {
      enqueue,
      channelContext: async () => {
        throw new Error("settings read failed");
      },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueuedPayload()).not.toHaveProperty("channel_settings");
  });

  it("the loader is asked for THIS channel, by slug", async () => {
    const loader = vi.fn().mockResolvedValue(SETTINGS_CONTEXT);
    await runChannelRecipe(TID, "reddit_organic", { enqueue, channelContext: loader });
    expect(loader).toHaveBeenCalledWith(TID, "reddit_organic");
  });
});
