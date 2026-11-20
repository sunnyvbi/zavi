// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { ActionsEmpty, StaleSignupBanner, type ChannelRunInfo } from "./ChannelEmptyStates";
import { platformFor } from "../actions/platforms";
import type { ChannelDetail } from "./channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    void 0;
  }
  apiFetch.mockReset().mockImplementation(async (path: string) => {
    if (path === "/api/channels") {
      return ok({
        channels: ["email_marketing", "linkedin_ads", "google_ads"].map((channel_slug) => ({
          channel_slug,
          run_reserve_credits: 120,
          last_run_id: RUN_ID,
        })),
      });
    }
    if (path.includes("/top-actions/runs/")) {
      return ok({ status: "done", actions: [], summary: "Your list is quiet this week." });
    }
    return ok({});
  });
});
afterEach(cleanup);

const runInfo = (slug: string, over: Partial<ChannelRunInfo> = {}): ChannelRunInfo => ({
  slug,
  name: platformFor(slug).name,
  switched: false,
  priorCount: 0,
  foldBelow: false,
  onRan: () => {},
  ...over,
});

const CREDIT_TEXT = /credit|120/i;

type Case = { name: string; workState: ChannelDetail["workState"]; over?: Partial<ChannelRunInfo>; planIntent?: string };
const CASES: Case[] = [
  { name: "never run", workState: "idle" },
  { name: "never run with the plan's intent", workState: "idle", planIntent: "Send a monthly win-back email" },
  { name: "last run did not finish", workState: "needs_review" },
  { name: "store moved", workState: "delivered", over: { switched: true, priorCount: 2 } },
  { name: "delivered, the last run said why", workState: "delivered" },
];

describe("a channel whose spec sets hideRunCost never quotes a run's credits on its empty state", () => {
  for (const hidden of ["email_marketing", "linkedin_ads"]) {
    for (const c of CASES) {
      it(`${hidden}: ${c.name}, with the server answering 120, prints no credit figure while google_ads beside it does`, async () => {
        render(
          <>
            <div data-testid="hidden">
              <ActionsEmpty workState={c.workState} lastRunAt={null} run={runInfo(hidden, c.over)} planIntent={c.planIntent ?? null} />
            </div>
            <div data-testid="shown">
              <ActionsEmpty workState={c.workState} lastRunAt={null} run={runInfo("google_ads", c.over)} planIntent={c.planIntent ?? null} />
            </div>
          </>,
        );
        const shown = screen.getByTestId("shown");
        await waitFor(() => expect(shown.textContent).toMatch(/~120 credits|About 120 credits/));
        const hiddenBox = screen.getByTestId("hidden");
        expect(within(hiddenBox).queryByTestId("run-cost")).toBeNull();
        expect(within(hiddenBox).queryByTestId("run-cost-slot")).toBeNull();
        expect(hiddenBox.textContent).not.toMatch(CREDIT_TEXT);
        expect(within(hiddenBox).getByTestId("run-channel")).toBeTruthy();
      });
    }
  }
});

describe("the aged signup banner's Refresh", () => {
  it("email_marketing: no credit figure on Refresh, while a google_ads banner with the same 120 answer says About 120 credits", async () => {
    render(
      <>
        <div data-testid="hidden">
          <StaleSignupBanner run={runInfo("email_marketing")} weeks={3} />
        </div>
        <div data-testid="shown">
          <StaleSignupBanner run={runInfo("google_ads")} weeks={3} />
        </div>
      </>,
    );
    await waitFor(() => expect(within(screen.getByTestId("shown")).getByText("About 120 credits")).toBeTruthy());
    const hiddenBox = screen.getByTestId("hidden");
    expect(within(hiddenBox).getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(hiddenBox.textContent).not.toMatch(CREDIT_TEXT);
  });

  it("email_marketing: no fallback credit line either when the channels read fails", async () => {
    apiFetch.mockReset().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<StaleSignupBanner run={runInfo("email_marketing")} weeks={2} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/channels"));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("stale-signup-banner").textContent).not.toMatch(/credit/i);
  });
});
