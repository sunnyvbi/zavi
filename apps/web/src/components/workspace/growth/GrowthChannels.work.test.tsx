// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GrowthChannels, RISK_BY_SLUG, channelStatus, orderedPlanChannels, type ChannelWork } from "./GrowthChannels";
import type { GrowthBet, GrowthChannel } from "@/lib/workspace/useGrowthPlan";

afterEach(cleanup);

const ch = (slug: string): GrowthChannel =>
  ({
    slug,
    last_run_at: null,
    last_run_status: null,
    metric_keys: [],
    metric_availability: "none",
    autorun: false,
    autorun_set_by: "plan",
    plan_selected: true,
    plan_selected_set_by: "plan",
  }) as unknown as GrowthChannel;
const bet = (slug: string, intent: string): GrowthBet =>
  ({ channel_slug: slug, intent, status: "accepted", rationale: null }) as unknown as GrowthBet;

function renderPlan(work: ChannelWork | null) {
  return render(
    <GrowthChannels
      channels={[ch("seo"), ch("reddit_organic"), ch("instagram_organic")]}
      bets={[
        bet("seo", "Win electric bike repair near me"),
        bet("reddit_organic", "Answer commuters in r/ebikes"),
        bet("instagram_organic", "One Reels format, weekly"),
      ]}
      unavailable={false}
      hasLivePlan
      hasPlan
      canEdit={false}
      savingSlugs={new Set()}
      onToggleAutorun={async () => {}}
      onSetInPlan={async () => {}}
      onAskZavi={() => {}}
      asking={false}
      work={work}
    />,
  );
}

describe("GrowthChannels, what Zavi already did", () => {
  it("shows each channel's count, or that it is running, in counts only", () => {
    renderPlan({
      counts: { seo: 3, reddit_organic: 1, linkedin_organic: 4 },
      running: new Set(["instagram_organic"]),
    });
    expect(screen.getByText("3 ready")).toBeTruthy();
    expect(screen.getByText("1 ready")).toBeTruthy();
    expect(screen.getByText("Running now")).toBeTruthy();
    expect(screen.queryByText("4 ready")).toBeNull();
  });

  it("with nothing waiting or running, says a channel has not run yet", () => {
    renderPlan({ counts: {}, running: new Set() });
    expect(screen.queryByText(/ ready$/)).toBeNull();
    expect(screen.getAllByText("Not run yet")).toHaveLength(3);
    cleanup();
    renderPlan(null);
    expect(screen.getAllByText("Not run yet")).toHaveLength(3);
  });

  it("falls back to the last run date when nothing is waiting", () => {
    expect(
      channelStatus({ ...ch("seo"), last_run_at: "2026-09-20T10:00:00Z" }, { counts: {}, running: new Set() }),
    ).toBe("Last ran Sep 20, 2026");
    expect(channelStatus({ ...ch("seo"), last_run_at: "2026-09-20T10:00:00Z" }, { counts: { seo: 2 }, running: new Set() })).toBe(
      "2 ready",
    );
  });
});

describe("plan order", () => {
  it("lists Zavi's bets by sort order, then the founder's adds by name", () => {
    const founder = (slug: string) => ({ ...ch(slug), plan_selected_set_by: "founder" as const });
    const ordered = orderedPlanChannels(
      [founder("sms"), ch("seo"), ch("meta_ads"), founder("email_marketing")],
      [
        { ...bet("seo", "x"), sort_order: 2 } as GrowthBet,
        { ...bet("meta_ads", "y"), sort_order: 1 } as GrowthBet,
      ],
      true,
    );
    expect(ordered.map((c) => c.slug)).toEqual(["meta_ads", "seo", "email_marketing", "sms"]);
  });
});

describe("what running alone would do", () => {
  it("comes from the tools a channel holds, not its category", () => {
    expect(RISK_BY_SLUG.get("google_ads")).toBe("spend money");
    expect(RISK_BY_SLUG.get("meta_ads")).toBe("spend money");
    expect(RISK_BY_SLUG.get("email_marketing")).toBe("send to your customers");
    expect(RISK_BY_SLUG.get("tiktok_ads")).toBe("spend money");
    expect(RISK_BY_SLUG.has("sms")).toBe(false);
    expect(RISK_BY_SLUG.has("seo")).toBe(false);
  });
});
