// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StaleSignupBanner, type ChannelRunInfo } from "./ChannelEmptyStates";
import { ChannelActionCard } from "../actions/ChannelActionCard";
import { platformFor } from "../actions/platforms";
import { makeAction } from "../actions/__tests__/fixtures";
import { signupPreviewWeeks } from "@/lib/workspace/channelActionsApi";

const apiFetch = vi.hoisted(() =>
  vi.fn(async (path: string, init?: { method?: string }) => {
    if (init?.method === "POST") return { ok: true, json: async () => ({ run_id: "run-12345678" }) };
    return { ok: true, json: async () => ({ channels: [] }) };
  }),
);
vi.mock("@/lib/api", () => ({ apiFetch }));

afterEach(() => {
  cleanup();
  apiFetch.mockClear();
});

const NOW = Date.parse("2026-09-23T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const run = (onRan = () => {}): ChannelRunInfo => ({
  slug: "seo",
  name: "SEO",
  switched: false,
  priorCount: 0,
  foldBelow: false,
  onRan,
});

describe("signup work older than a week", () => {
  it("is aged in whole weeks, and fresh or non-signup work is not", () => {
    expect(signupPreviewWeeks({ from_signup_preview_at: daysAgo(21) }, NOW)).toBe(3);
    expect(signupPreviewWeeks({ from_signup_preview_at: daysAgo(8) }, NOW)).toBe(1);
    expect(signupPreviewWeeks({ from_signup_preview_at: daysAgo(7) }, NOW)).toBeNull();
    expect(signupPreviewWeeks({}, NOW)).toBeNull();
  });

  it("the banner says when, and Refresh starts a normal run of the channel", async () => {
    const onRan = vi.fn();
    render(<StaleSignupBanner run={run(onRan)} weeks={3} />);
    expect(screen.getByTestId("stale-signup-banner").textContent).toContain(
      "Found 3 weeks ago, when you signed up.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(onRan).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledWith("/api/channels/seo/run", expect.objectContaining({ method: "POST" }));
  });

  it("one week reads singular", () => {
    render(<StaleSignupBanner run={run()} weeks={1} />);
    expect(screen.getByTestId("stale-signup-banner").textContent).toContain("Found 1 week ago");
  });

  it("an old signup card carries an age tag; a normal card does not", () => {
    const old = makeAction("fix", {
      channel_slug: "seo",
      title: "Rewrite the title on /repairs",
      from_signup_preview_at: new Date(Date.now() - 21 * 86_400_000).toISOString(),
    });
    const fresh = makeAction("fix", { id: "fresh", channel_slug: "seo", title: "Draft the page" });
    const h = { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn() };
    render(
      <>
        <ChannelActionCard action={old} platform={platformFor("seo")} handlers={h} />
        <ChannelActionCard action={fresh} platform={platformFor("seo")} handlers={h} />
      </>,
    );
    expect(screen.getByTestId(`action-${old.id}`).textContent).toContain("3 wk old");
    expect(screen.getByTestId("action-fresh").textContent).not.toContain("wk old");
  });
});
