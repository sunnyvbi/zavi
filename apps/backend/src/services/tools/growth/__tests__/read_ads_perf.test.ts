import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const googleCall = vi.fn();
const metaCall = vi.fn();
vi.mock("@/services/mcp/internal/google-ads", () => ({ callGoogleAdsTool: (...a: unknown[]) => googleCall(...a) }));
vi.mock("@/services/mcp/internal/meta-ads", () => ({ callMetaAdsTool: (...a: unknown[]) => metaCall(...a) }));

import { readAdsPerfTool, fullDaysWindow } from "../read_ads_perf";

const ok = (body: unknown) => ({ ok: true, is_error: false, content: JSON.stringify(body), ms: 1 });
const fail = (error: string, message = "x") => ({ ok: false, is_error: true, content: JSON.stringify({ error, message }), ms: 1 });

describe("growth.read_ads_perf", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T15:00:00Z"));
    googleCall.mockReset().mockResolvedValue(ok({ totals: { spend_usd: 370 } }));
    metaCall.mockReset().mockResolvedValue(ok({ totals: { spend_usd: 1546 } }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["chatgpt_ads", "meta_ads", "google_ads", "youtube_ads"])(
    "does not let %s use the combined reader to bypass its channel scope",
    async (agent_slug) => {
      await expect(readAdsPerfTool.execute({ tenant_id: "t1", agent_slug, log: () => {} }, {
        agent_slug: "operator",
      })).rejects.toMatchObject({ code: "channel_scope_mismatch" });
      expect(googleCall).not.toHaveBeenCalled();
      expect(metaCall).not.toHaveBeenCalled();
    },
  );

  it.each(["operator"])("keeps the declared combined reader for %s", async (agent_slug) => {
    await readAdsPerfTool.execute({ tenant_id: "t1", agent_slug, log: () => {} }, {});
    expect(googleCall).toHaveBeenCalledOnce();
    expect(metaCall).toHaveBeenCalledOnce();
  });

  it("reads BOTH platforms over the SAME last-7-full-days window, every status (B4)", async () => {
    await readAdsPerfTool.execute({ tenant_id: "t1" } as never, {});
    const window = { since: "2026-09-21", until: "2026-09-27" };
    expect(googleCall).toHaveBeenCalledWith({ tenant_id: "t1" }, "list_campaigns", { custom_range: window, status: "ALL" });
    expect(metaCall).toHaveBeenCalledWith({ tenant_id: "t1" }, "list_campaigns", { time_range: window, status: "ALL" });
  });

  it("puts the window in the payload and returns both platforms", async () => {
    const out = (await readAdsPerfTool.execute({ tenant_id: "t1" } as never, {})) as Record<string, unknown>;
    expect(out.window).toEqual({ since: "2026-09-21", until: "2026-09-27", days: 7, statuses: "ALL" });
    expect(out.meta_ads).toEqual({ totals: { spend_usd: 1546 } });
    expect(out.google_ads).toEqual({ totals: { spend_usd: 370 } });
  });

  it("window_days widens both platforms together", async () => {
    await readAdsPerfTool.execute({ tenant_id: "t1" } as never, { window_days: 30 });
    const window = { since: "2026-08-29", until: "2026-09-27" };
    expect(metaCall.mock.calls[0][2]).toEqual({ time_range: window, status: "ALL" });
    expect(googleCall.mock.calls[0][2]).toEqual({ custom_range: window, status: "ALL" });
  });

  it("an expired token on a connected account is read_failed with the reason, not not_connected (B3)", async () => {
    metaCall.mockResolvedValue(fail("meta_ads_token_expired", "token expired"));
    const out = (await readAdsPerfTool.execute({ tenant_id: "t1" } as never, {})) as Record<string, unknown>;
    expect(out.meta_ads).toEqual({ read_failed: true, reason: "meta_ads_token_expired: token expired" });
    expect(out.google_ads).toEqual({ totals: { spend_usd: 370 } });
  });

  it("a platform that is not wired reads as not_connected", async () => {
    googleCall.mockResolvedValue(fail("google_ads_not_connected"));
    const out = (await readAdsPerfTool.execute({ tenant_id: "t1" } as never, {})) as Record<string, unknown>;
    expect(out.google_ads).toEqual({ not_connected: true });
  });

  it("nothing connected -> ads_not_connected", async () => {
    googleCall.mockResolvedValue(fail("google_ads_not_connected"));
    metaCall.mockResolvedValue(fail("meta_ads_not_connected"));
    await expect(readAdsPerfTool.execute({ tenant_id: "t1" } as never, {})).rejects.toMatchObject({ code: "ads_not_connected" });
  });

  it("connected but every read failed -> ads_read_failed, never ads_not_connected", async () => {
    googleCall.mockResolvedValue(fail("google_ads_not_connected"));
    metaCall.mockResolvedValue(fail("meta_ads_timeout", "slow"));
    await expect(readAdsPerfTool.execute({ tenant_id: "t1" } as never, {})).rejects.toMatchObject({
      code: "ads_read_failed",
      meta: { google_ads: "not_connected", meta_ads: "meta_ads_timeout: slow" },
    });
  });
});

describe("fullDaysWindow", () => {
  it("N full days ending on the last complete day", () => {
    expect(fullDaysWindow(7, new Date("2026-03-01T12:30:00Z"))).toEqual({ since: "2026-02-22", until: "2026-02-28" });
    expect(fullDaysWindow(7, new Date("2026-03-01T00:30:00Z"))).toEqual({ since: "2026-02-21", until: "2026-02-27" });
    expect(fullDaysWindow(1, new Date("2026-09-28T23:59:00Z"))).toEqual({ since: "2026-09-27", until: "2026-09-27" });
  });
});
