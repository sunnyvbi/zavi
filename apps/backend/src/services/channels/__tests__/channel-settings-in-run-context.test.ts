import { beforeEach, describe, expect, it, vi } from "vitest";

const TID = "73db45ff-457e-4541-bc8f-bdb625390204";

const h = vi.hoisted(() => {
  const store: Record<string, Record<string, Array<Record<string, unknown>>>> = {
    google_ads: {
      keywords: [
        { id: "kw-1", item: "fleet insurance", item_type: "problem", status: "tracking" },
      ],
      negative_keywords: [{ id: "nk-1", item: "free car", status: "tracking" }],
    },
    reddit_organic: {
      subreddits: [{ id: "sr-1", item: "r/whatcarshouldibuy", status: "tracking" }],
    },
  };
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const tenantRpc = vi.fn(async (_t: string, fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> => {
    calls.push({ fn, args });
    if (fn !== "get_channel_settings") return { data: null, error: null };
    const slug = String(args.p_channel_slug ?? "");
    if (slug.trim() === "") throw new Error("get_channel_settings: p_channel_slug is required");
    return { data: { fields: store[slug] ?? {} }, error: null };
  });
  return { store, calls, tenantRpc };
});

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: h.tenantRpc,
}));

vi.mock("@/services/channels/reddit/db", () => ({
  redditDb: () => ({}),
}));
vi.mock("../reddit/workspace", () => ({
  readRedditWorkspace: async () => ({ keywords: [], competitors: [], communities: [] }),
  workspaceRunContext: () => ({ keywords: ["legacy reddit keyword"] }),
}));

import { defaultChannelContext } from "@/services/channels/context";

beforeEach(() => {
  h.calls.length = 0;
  h.tenantRpc.mockClear();
});

describe("GUARD 19 — the run reads what the Settings tab wrote", () => {
  it("fixture check: the store really holds rows for both channels", () => {
    expect(h.store.google_ads.keywords).toHaveLength(1);
    expect(h.store.reddit_organic.subreddits).toHaveLength(1);
  });

  it("surfaces a saved setting for a NON-reddit channel", async () => {
    const ctx = await defaultChannelContext(TID, "google_ads");
    expect(
      ctx,
      "defaultChannelContext returns null for every channel except reddit_organic, " +
        "so nothing a founder saves on the Settings tab reaches the run. The Settings " +
        "tab is decorative until this loader reads channel_settings.",
    ).not.toBeNull();
    expect(JSON.stringify(ctx)).toContain("fleet insurance");
  });

  it("surfaces EVERY field, not just the first one", async () => {
    const ctx = await defaultChannelContext(TID, "google_ads");
    const json = JSON.stringify(ctx);
    expect(json).toContain("fleet insurance");
    expect(json).toContain("free car");
  });

  it("reads THIS channel only — no other channel's settings ride along", async () => {
    const ctx = await defaultChannelContext(TID, "google_ads");
    expect(JSON.stringify(ctx)).not.toContain("r/whatcarshouldibuy");
  });

  it("names the channel on every settings read it makes", async () => {
    await defaultChannelContext(TID, "google_ads");
    const reads = h.calls.filter((c) => c.fn === "get_channel_settings");
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.args.p_channel_slug).toBe("google_ads");
  });

  it("a channel with no rows loads cleanly rather than throwing", async () => {
    await expect(defaultChannelContext(TID, "meta_ads")).resolves.not.toThrow();
  });

  it("does NOT delete reddit's existing workspace context on the way", async () => {
    const ctx = await defaultChannelContext(TID, "reddit_organic");
    expect(ctx).not.toBeNull();
    expect(JSON.stringify(ctx)).toContain("legacy reddit keyword");
  });
});

it("distinguishes an unavailable settings read from an empty saved list", async () => {
  h.tenantRpc.mockResolvedValueOnce({ data: null, error: { message: "unavailable" } });
  expect(await defaultChannelContext(TID, "x_ads")).toEqual({ channel_settings_unavailable: true });
});
