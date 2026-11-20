// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GrowthChannels } from "./GrowthChannels";
import type { GrowthChannel } from "@/lib/workspace/useGrowthPlan";

afterEach(cleanup);

const ch = (slug: string, autorun = false): GrowthChannel =>
  ({
    slug,
    last_run_at: null,
    last_run_status: null,
    metric_keys: [],
    metric_availability: "none",
    autorun,
    autorun_set_by: autorun ? "founder" : "plan",
    plan_selected: true,
    plan_selected_set_by: "plan",
  }) as unknown as GrowthChannel;

function renderStory(
  autopilot: boolean,
  channels: GrowthChannel[],
  canEdit = true,
  canStop = canEdit,
  channelLocks?: Record<string, unknown> | null,
) {
  return render(
    <GrowthChannels
      variant="story"
      autopilot={autopilot}
      channelLocks={channelLocks}
      channels={channels}
      bets={[]}
      unavailable={false}
      hasLivePlan
      hasPlan
      canEdit={canEdit}
      canStop={canStop}
      savingSlugs={new Set()}
      onToggleAutorun={async () => {}}
      onSetInPlan={async () => {}}
      onAskZavi={() => {}}
      asking={false}
    />,
  );
}

describe("GrowthChannels story rows under Autopilot", () => {
  it("Autopilot on, switch off: the channel asks first and keeps its switch", () => {
    renderStory(true, [ch("seo"), ch("email_marketing"), ch("meta_ads")]);
    expect(screen.getAllByText("Asks you first")).toHaveLength(3);
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    expect(screen.queryByText(/Run by CGO/)).toBeNull();
  });

  it("Autopilot on, switch on: CGO may run it, and the switch turns it back", () => {
    renderStory(true, [ch("seo", true)]);
    expect(screen.getByText("CGO may run this, posts wait for you")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Make SEO ask you first" })).toBeTruthy();
  });

  it("a channel CGO never runs says so, whatever the switch holds", () => {
    renderStory(true, [{ ...ch("chatgpt_ads", true), auto_capable: false } as GrowthChannel]);
    expect(screen.getByText("Manual paid control · separate ads wallet")).toBeTruthy();
  });

  it("with Autopilot off, no channel offers a switch: each runs by itself once Autopilot is on", () => {
    renderStory(false, [ch("seo"), ch("meta_ads", true)]);
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.getAllByText("Runs by itself once Autopilot is on")).toHaveLength(2);
  });

  it("with Autopilot off, ChatGPT keeps its paid-consent switch (Autopilot never implies it)", () => {
    renderStory(false, [ch("chatgpt_ads", true)]);
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.getByText("CGO may manage ads once Autopilot is on")).toBeTruthy();
  });
});

it("a channel CGO never runs offers no switch (it would change nothing)", () => {
  renderStory(true, [{ ...ch("chatgpt_ads", false), auto_capable: false } as GrowthChannel, ch("seo")]);
  expect(screen.getAllByRole("switch")).toHaveLength(1);
  expect(screen.queryByRole("switch", { name: /ChatGPT/ })).toBeNull();
});

it("members can turn ChatGPT off but cannot grant paid delegation", () => {
  const mounted = renderStory(true, [ch("chatgpt_ads", true)], false, true);
  expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(false);
  mounted.unmount();
  renderStory(true, [ch("chatgpt_ads", false)], false, true);
  expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
});

it("viewers cannot stop ChatGPT (the server refuses them)", () => {
  renderStory(true, [ch("chatgpt_ads", true)], false, false);
  expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
});

describe("a channel the plan does not include", () => {
  it("on Free, names the plan it needs instead of promising Autopilot runs it", () => {
    renderStory(false, [ch("seo"), ch("tiktok_organic"), ch("meta_ads")], true, true, {
      seo: "starter",
      tiktok_organic: "growth",
      meta_ads: "pro",
    });
    expect(screen.getByText("Needs Starter")).toBeTruthy();
    expect(screen.getByText("Needs Growth")).toBeTruthy();
    expect(screen.getByText("Needs Pro")).toBeTruthy();
    expect(screen.queryByText(/Runs by itself once Autopilot is on/)).toBeNull();
  });

  it("under Autopilot too, a locked channel does not say CGO may run it, and offers no switch", () => {
    renderStory(true, [ch("seo", true), ch("blog")], true, true, { seo: "starter", blog: null });
    expect(screen.getByText("Needs Starter")).toBeTruthy();
    expect(screen.queryByText(/CGO may run this/)).toBeNull();
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.queryByRole("switch", { name: /SEO/ })).toBeNull();
  });

  it("while the plan is unknown (loading or a failed read), no row promises a run", () => {
    const mounted = renderStory(false, [ch("seo")], true, true, null);
    expect(screen.queryByText(/Runs by itself/)).toBeNull();
    mounted.unmount();
    renderStory(true, [ch("seo", true)], true, true, {});
    expect(screen.queryByText(/CGO may run this/)).toBeNull();
  });

  it("while the plan is unknown, no switch and no 'asks you first' either", () => {
    renderStory(true, [ch("seo", false), ch("chatgpt_ads", false)], true, true, null);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/asks you first/i)).toBeNull();
    expect(screen.queryByText(/starts only when asked/i)).toBeNull();
  });

  it("an included channel (no lock) reads as before", () => {
    renderStory(false, [ch("seo")], true, true, { seo: null });
    expect(screen.getByText("Runs by itself once Autopilot is on")).toBeTruthy();
  });
});
