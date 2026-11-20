// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { AdPlacementPreview } from "./AdPlacementPreview";
import { draftAdFields } from "./draftAdFields";

afterEach(cleanup);

const BODY = "Intro text (75/150): Design a custom cake for your occasion. Every one is made to order.\nHeadline (20/70): Design your own cake\nCTA: Learn More";

describe("a draft ad written as labelled lines", () => {
  it("must catch: the preview reads like an ad, intro then headline and button, with no field labels or character counts", () => {
    render(<AdPlacementPreview creative={{ body: BODY, advertiser: "Cake Studio" }} format="feed" platformName="LinkedIn" channelSlug="linkedin_ads" draftOnly />);
    const card = screen.getByTestId("draft-ad-card");
    expect(card.textContent).not.toMatch(/Intro text|Headline|CTA|75\/150|20\/70/);
    expect(within(card).getByText("Design a custom cake for your occasion. Every one is made to order.")).toBeTruthy();
    expect(within(card).getByText("Design your own cake")).toBeTruthy();
    expect(within(card).getByText("Learn More")).toBeTruthy();
    expect(within(card).getByText("Cake Studio")).toBeTruthy();
  });

  it("keeps a multi-line intro whole, and leaves free text alone so nothing is dropped", () => {
    expect(draftAdFields("Intro text: line one\nline two\nHeadline: Big")).toEqual({ intro: "line one\nline two", headline: "Big", description: "", cta: "" });
    expect(draftAdFields("Just a sentence about cakes.\nHeadline: Big")).toBeNull();
    expect(draftAdFields("Headline: only one label")).toBeNull();
    render(<AdPlacementPreview creative={{ body: "Plain words only." }} format="feed" platformName="LinkedIn" channelSlug="linkedin_ads" draftOnly />);
    expect(screen.queryByTestId("draft-ad-card")).toBeNull();
    expect(screen.getByText("Plain words only.")).toBeTruthy();
  });
});
