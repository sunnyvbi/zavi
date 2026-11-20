import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "11111111-1111-1111-1111-111111111111";

const h = vi.hoisted(() => ({ tier: "free" as string }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const single = async () =>
        table === "system_config"
          ? { data: { blob: {} }, error: null }
          : { data: { tier: h.tier, status: "active" }, error: null };
      const chain = { eq: () => chain, maybeSingle: single };
      return { select: () => chain };
    },
  }),
}));

import { isSignupPreviewRun, previewRunKey, type RunFacts } from "../tiers";
import { checkAgentTier } from "@/services/agents/entitlement";

const server = (tenant: string, slug: string, over: Partial<RunFacts> = {}): RunFacts => ({
  trigger: "channel_recipe",
  enqueuedByUser: false,
  payload: {},
  cronDedupeKey: previewRunKey(tenant, slug),
  ...over,
});

beforeEach(() => {
  h.tier = "free";
});

describe("isSignupPreviewRun", () => {
  it("admits the server-marked run for its own tenant and Starter channel", () => {
    expect(isSignupPreviewRun(T, "seo", server(T, "seo"))).toBe(true);
  });
  it("refuses a user-enqueued run carrying the same key", () => {
    expect(isSignupPreviewRun(T, "seo", server(T, "seo", { enqueuedByUser: true }))).toBe(false);
  });
  it("refuses a key minted for another tenant", () => {
    expect(isSignupPreviewRun(T, "seo", server(OTHER, "seo"))).toBe(false);
  });
  it("refuses a key minted for another channel", () => {
    expect(isSignupPreviewRun(T, "geo", server(T, "seo"))).toBe(false);
  });
  it("refuses a Pro channel even with a well-formed key", () => {
    expect(isSignupPreviewRun(T, "meta_ads", server(T, "meta_ads"))).toBe(false);
  });
  it("refuses another trigger (a drained work item, a chat run)", () => {
    expect(isSignupPreviewRun(T, "seo", server(T, "seo", { trigger: "cron" }))).toBe(false);
    expect(isSignupPreviewRun(T, "seo", server(T, "seo", { trigger: "chat" }))).toBe(false);
  });
  it("ignores a flag copied into the payload: only the row's own facts count", () => {
    expect(
      isSignupPreviewRun(T, "seo", server(T, "seo", { cronDedupeKey: null, payload: { preview: true, cron_dedupe_key: previewRunKey(T, "seo") } })),
    ).toBe(false);
  });
});

describe("the channel tier gate", () => {
  it("lets the preview run through on Free", async () => {
    const d = await checkAgentTier(T, "seo", { run: server(T, "seo") });
    expect(d.allowed).toBe(true);
  });
  it("still refuses a user-enqueued run of the same channel on Free", async () => {
    const d = await checkAgentTier(T, "seo", { run: server(T, "seo", { enqueuedByUser: true }) });
    expect(d).toMatchObject({ allowed: false, required_tier: "starter" });
  });
  it("still refuses a plain server run of the same channel on Free (no preview key)", async () => {
    const d = await checkAgentTier(T, "seo", { run: server(T, "seo", { cronDedupeKey: null }) });
    expect(d).toMatchObject({ allowed: false, required_tier: "starter" });
  });
});

describe("an admitted preview run survives a tier-map move", () => {
  it("is allowed at execution even when its channel is no longer Starter", async () => {
    const d = await checkAgentTier(T, "meta_ads", { run: server(T, "meta_ads") });
    expect(d.allowed).toBe(true);
  });
});
