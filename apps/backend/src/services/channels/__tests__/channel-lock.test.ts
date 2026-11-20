
import { describe, it, expect, vi, beforeEach } from "vitest";

const configRead = vi.fn();
const rpc = vi.fn();
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: (t: string, n: string, a: Record<string, unknown>) => rpc(t, n, a),
  globalClient: () => ({
    from: (table: string) => {
      if (table !== "system_config") throw new Error(`unexpected table ${table}`);
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => configRead(),
      };
      return chain;
    },
  }),
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
import { admitDirectChannelRun, refusedHandoffPayload } from "@/services/channels/direct-run";
import {
  isChannelLockedStrict,
  lockedChannelMessageForAgent,
  lockedSlugsFromBlob,
  readLockedChannelSlugs,
} from "@/services/channels/lock";
import { channelsDue } from "@/services/channels/due";
import { assembleChannels } from "@/routes/channels/list";
import { joinChannelStates } from "@/services/channels/state";

const TID = "33333333-3333-3333-3333-333333333333";
const enqueue = vi.fn();

const lockedConfig = (...slugs: string[]) => ({
  data: { blob: { locked_channel_slugs: slugs } },
  error: null,
});

beforeEach(() => {
  configRead.mockReset();
  rpc.mockReset();
  claim.mockReset();
  enqueue.mockReset();
  rpc.mockResolvedValue({ data: true, error: null });
  enqueue.mockResolvedValue({ run_id: "run-1" });
  claim.mockResolvedValue({ kind: "claimed", claim_id: "claim-1" });
  configRead.mockResolvedValue({ data: { blob: {} }, error: null });
});

describe("runChannelRecipe — locked channel", () => {
  it("refuses with coming_soon and never admits or enqueues", async () => {
    configRead.mockResolvedValue(lockedConfig("meta_ads"));
    const r = await runChannelRecipe(TID, "meta_ads", { enqueue });
    expect(r).toEqual({ ok: false, reason: "coming_soon", message: "Meta Ads is coming soon." });
    expect(claim).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a lock on ANOTHER channel does not block this one", async () => {
    configRead.mockResolvedValue(lockedConfig("google_ads"));
    const r = await runChannelRecipe(TID, "meta_ads", { enqueue });
    expect(r.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("fails OPEN when the config read returns an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    configRead.mockResolvedValue({ data: null, error: { message: "db blip" } });
    const r = await runChannelRecipe(TID, "meta_ads", { enqueue });
    expect(r.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("db blip"));
    warn.mockRestore();
  });

  it("fails OPEN when the config read throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    configRead.mockRejectedValue(new Error("socket hang up"));
    expect((await readLockedChannelSlugs()).size).toBe(0);
    const r = await runChannelRecipe(TID, "meta_ads", { enqueue });
    expect(r.ok).toBe(true);
    warn.mockRestore();
  });
});

describe("refusedHandoffPayload", () => {
  it("a locked channel tells the caller to answer with its own reads, not stop", () => {
    const p = refusedHandoffPayload({ allowed: false, reason: "coming_soon", message: "SMS is coming soon." });
    expect(p.error).toBe("coming_soon");
    expect(p.message).toBe("SMS is coming soon.");
    expect(p.next_step).toMatch(/read tools you already have/);
    expect(p.next_step).not.toMatch(/growth__|web_search__|apify__/);
  });

  it("a spend cap refusal carries no next_step", () => {
    const p = refusedHandoffPayload({ allowed: false, reason: "budget", message: "Cap reached." });
    expect(p).toEqual({ error: "channel_budget_exhausted", message: "Cap reached." });
  });
});

describe("admitDirectChannelRun — locked channel", () => {
  it("refuses a chat/handoff run of a locked channel's executor", async () => {
    configRead.mockResolvedValue(lockedConfig("meta_ads"));
    const r = await admitDirectChannelRun(TID, "meta_ads");
    expect(r).toEqual({ allowed: false, reason: "coming_soon", message: "Meta Ads is coming soon." });
    expect(claim).not.toHaveBeenCalled();
  });

  it("does not read the lock for a non-channel agent", async () => {
    const r = await admitDirectChannelRun(TID, "operator");
    expect(r.allowed).toBe(true);
    expect(configRead).not.toHaveBeenCalled();
  });
});

describe("lockedSlugsFromBlob", () => {
  it("keeps registry slugs only and dedupes", () => {
    expect(
      lockedSlugsFromBlob({ locked_channel_slugs: ["seo", "seo", "nope", 7, null] }),
    ).toEqual(["seo"]);
    expect(lockedSlugsFromBlob({})).toEqual([]);
    expect(lockedSlugsFromBlob({ locked_channel_slugs: "seo" })).toEqual([]);
  });
});

describe("channelsDue — a locked channel does not take a sweep slot", () => {
  it("skips the locked slug and fills the slot with the next due channel", () => {
    const linked = new Set(["meta_ads", "google_ads"]);
    const now = Date.parse("2026-09-16T07:00:00.000Z");
    const open = channelsDue([], linked, now, 10);
    expect(open).toContain("meta_ads");
    const withLock = channelsDue([], linked, now, 10, false, false, new Set(["meta_ads"]));
    expect(withLock).not.toContain("meta_ads");
    expect(withLock.length).toBe(open.length - 1);
  });
});

describe("assembleChannels — carries locked", () => {
  it("marks only the locked channel, and defaults to unlocked", () => {
    const base = {
      states: joinChannelStates([{ channel_slug: "seo" }]),
      linked: new Set<string>(),
      latestRun: new Map(),
      runsAvailable: true,
      now: Date.now(),
      staleMs: 7_200_000,
    };
    const out = assembleChannels({ ...base, locked: new Set(["ugc"]) });
    expect(out.find((c) => c.channel_slug === "ugc")!.locked).toBe(true);
    expect(out.filter((c) => c.locked)).toHaveLength(1);
    expect(assembleChannels(base).every((c) => c.locked === false)).toBe(true);
  });
});

describe("lockedChannelMessageForAgent — the by-slug run paths", () => {
  it("returns the Coming soon message for a locked channel's executor", async () => {
    configRead.mockResolvedValue(lockedConfig("meta_ads"));
    expect(await lockedChannelMessageForAgent("meta_ads")).toBe("Meta Ads is coming soon.");
  });

  it("is null for an unlocked channel agent and for a non-channel agent", async () => {
    configRead.mockResolvedValue(lockedConfig("meta_ads"));
    expect(await lockedChannelMessageForAgent("google_ads")).toBeNull();
    expect(await lockedChannelMessageForAgent("engineer")).toBeNull();
  });

  it("locking geo does not lock seo (they share no agent any more)", async () => {
    configRead.mockResolvedValue(lockedConfig("geo"));
    expect(await lockedChannelMessageForAgent("seo")).toBeNull();
    expect(await lockedChannelMessageForAgent("geo")).toBe("GEO is coming soon.");
  });
});

describe("isChannelLockedStrict — unreadable config", () => {
  const plain = "Zavi could not check whether this channel is available. Try again in a minute.";
  it.each([
    ["a read error", () => configRead.mockResolvedValue({ data: null, error: { message: "permission denied for table system_config" } })],
    ["a missing row", () => configRead.mockResolvedValue({ data: null, error: null })],
    ["a rejected read", () => configRead.mockRejectedValue(new Error("fetch failed: ECONNRESET at system_config"))],
  ])("fails closed with founder words on %s", async (_label, arrange) => {
    arrange();
    const err = await isChannelLockedStrict("linkedin_ads").then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe(plain);
    expect(err?.message).not.toMatch(/config|system_config|ECONNRESET|permission denied/i);
  });

  it("still reads a locked channel as locked", async () => {
    configRead.mockResolvedValue(lockedConfig("linkedin_ads"));
    await expect(isChannelLockedStrict("linkedin_ads")).resolves.toBe(true);
    await expect(isChannelLockedStrict("meta_ads")).resolves.toBe(false);
  });
});
