// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => null }));
vi.mock("./reconnectFlows", () => ({ startReconnectFlow: vi.fn() }));

import { adReadFlags, readSlowReason } from "./useAdReadFailures";
import { ReconnectTile } from "./ReconnectTile";

afterEach(cleanup);

const NOW = Date.parse("2026-10-12T12:00:00Z");

describe("adReadFlags: Reconnect only for a login problem", () => {
  it("auth / account_gone ask for a reconnect; busy is slow only after 3h; disconnected is nothing", () => {
    const out = adReadFlags([{
      read_failed: {
        reddit: "2026-10-12T11:00:00Z", meta: "2026-10-12T11:30:00Z",
        tiktok: "2026-10-12T10:00:00Z", google: "2026-10-12T08:00:00Z",
        linkedin: "2026-10-01T00:00:00Z", x: "2026-10-12T08:30:00Z",
      },
      read_failure_kinds: { reddit: "auth", meta: "account_gone", tiktok: "vendor_error", google: "timeout", linkedin: "disconnected" },
    }], NOW);
    expect(out.failed).toEqual({ reddit_ads: "2026-10-12T11:00:00Z", meta_ads: "2026-10-12T11:30:00Z" });
    expect(out.slow).toEqual({ google_ads: "2026-10-12T08:00:00Z", x_ads: "2026-10-12T08:30:00Z" });
  });

  it("a login problem on any budget wins over a slow read of the same platform", () => {
    const out = adReadFlags([
      { read_failed: { tiktok: "2026-10-12T05:00:00Z" }, read_failure_kinds: { tiktok: "timeout" } },
      { read_failed: { tiktok: "2026-10-12T11:00:00Z" }, read_failure_kinds: { tiktok: "auth" } },
    ], NOW);
    expect(out.failed).toEqual({ tiktok_ads: "2026-10-12T11:00:00Z" });
    expect(out.slow).toEqual({});
  });
});

describe("the not-answering tile offers no Reconnect", () => {
  it("showReconnect=false: the words, no button", () => {
    render(<ReconnectTile slug="tiktok_ads" label="TikTok Ads" reason={readSlowReason("TikTok Ads")} statusText="Not answering" showReconnect={false} readOnly={false} />);
    expect(screen.getByText("TikTok Ads hasn't answered for 3 hours. Zavi keeps trying; budget raises on TikTok Ads wait until it reads again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reconnect/i })).toBeNull();
  });

  it("a login problem still has its Reconnect button", () => {
    render(<ReconnectTile slug="reddit_ads" label="Reddit Ads" reason="x" readOnly={false} />);
    expect(screen.getByRole("button", { name: /reconnect/i })).toBeTruthy();
  });
});
