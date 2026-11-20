// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as api from "@/lib/api";
import { ChannelActionCard } from "../../ChannelActionCard";
import { makeAction } from "../../__tests__/fixtures";
import { platformFor } from "../../platforms";
import type { ActionHandlers, ActionItem } from "../../types";
import { AdsPresentation } from "../AdsPresentation";
import { AdReviewFacts } from "../AdReviewFacts";
import { adReviewModel } from "../adReviewModel";
import { isAdTask } from "../adSections";

function handlers(): ActionHandlers {
  return { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onReviseAd: vi.fn(async () => true) };
}

function card(action: ActionItem) {
  const props = { action, handlers: handlers(), platform: platformFor(action.channel_slug) };
  return <AdsPresentation value={props}><ChannelActionCard {...props} /></AdsPresentation>;
}

function reviewTask(): ActionItem {
  return makeAction("check", {
    channel_slug: "meta_ads",
    executable: false,
    title: "Approve or reject the $149 to $178.80 raise",
    body: { intent: "review", owner: "founder", step: { title: "Approve or reject the $149 to $178.80 raise", body: "Decide whether the Oct 26 revert still applies.", evidence: [] } },
  } as never);
}

beforeEach(() => {
  vi.spyOn(api, "apiFetch").mockImplementation(async () => new Response("{}", { status: 200 }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("an ads review card with nothing to run is a task", () => {
  it("is a task whatever its section, and an executable card is not", () => {
    expect(isAdTask(reviewTask())).toBe(true);
    expect(isAdTask(makeAction("update_ad", { channel_slug: "meta_ads", executable: true } as never))).toBe(false);
  });

  it("renders the compact layout with no Cost or Comes from rows", () => {
    render(card(reviewTask()));
    expect(screen.getByRole("heading", { name: "Approve or reject the $149 to $178.80 raise" })).toBeTruthy();
    expect(screen.queryByTestId("ad-cost")).toBeNull();
    expect(screen.queryByTestId("ad-provenance")).toBeNull();
    expect(screen.queryByText(/not provided/i)).toBeNull();
  });
});

describe("AdReviewFacts", () => {
  it("leaves out a budget or creative source the card does not carry", () => {
    const model = adReviewModel(makeAction("update_ad", { channel_slug: "meta_ads", executable: true } as never));
    render(<AdReviewFacts description="Raise the budget." model={{ ...model, cost: null, provenance: null }} platformName="Meta Ads" />);
    expect(screen.getByTestId("ad-description").textContent).toBe("Raise the budget.");
    expect(screen.getByTestId("ad-destination").textContent).toBe("Meta Ads");
    expect(screen.queryByTestId("ad-cost")).toBeNull();
    expect(screen.queryByTestId("ad-provenance")).toBeNull();
  });

  it("shows the budget and source when the card has them", () => {
    const model = adReviewModel(makeAction("update_ad", { channel_slug: "meta_ads", executable: true } as never));
    render(<AdReviewFacts description="Raise the budget." model={{ ...model, cost: "$178.80 a day", provenance: "Your saved ad" }} platformName="Meta Ads" />);
    expect(screen.getByTestId("ad-cost").textContent).toBe("$178.80 a day");
    expect(screen.getByTestId("ad-provenance").textContent).toBe("Your saved ad");
  });
});
