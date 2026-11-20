// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ calls: [] as Array<{ path: string; init?: RequestInit }>, routes: {} as Record<string, unknown>, location: "/workspace?tab=channels&channel=google_ads" }));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    h.calls.push({ path, init });
    const key = Object.keys(h.routes).find((k) => path.startsWith(k));
    const body = key ? h.routes[key] : { error: { message: "nope" } };
    return new Response(JSON.stringify(body), { status: key ? 200 : 404 });
  }),
}));
vi.mock("../navigation/workspaceRoutes", () => ({
  readWorkspaceLocation: () => h.location,
  replaceWorkspaceLocation: (href: string) => {
    h.location = href;
  },
}));

import { AdLocationsCard, countryArticle, joinAnd } from "./AdLocations";

const FP = "a".repeat(64);
const needsYou = {
  state: "needs_you",
  channel: "google_ads",
  campaign: { id: "555", name: "Zavi · Coffee" },
  country: { code: "US", name: "United States" },
  places: [{ id: "2840", name: "United States", kind: "Country" }],
  targeting: "single",
  ad_groups: 0,
  pending: false,
  last_error: null,
  order_cities: ["San Francisco", "Oakland", "San Jose"],
  fingerprint: FP,
};
const suggestions = {
  orders: "confirmed",
  country: { code: "US", name: "United States" },
  places: [
    { id: "1014221", name: "San Francisco, CA", kind: "City", source: "orders", reason: "34% of your orders in the last 90 days" },
    { id: "1014044", name: "Oakland, CA", kind: "City", source: "orders", reason: "12% of your orders" },
    { id: "1014000", name: "San Jose, CA", kind: "City", source: "address", reason: "Where you are" },
  ],
  picked: ["1014221", "1014044"],
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
beforeEach(() => {
  h.calls = [];
  h.location = "/workspace?tab=channels&channel=google_ads";
  h.routes = {
    "/api/channels/google_ads/ad-locations/suggestions": suggestions,
    "/api/channels/google_ads/ad-locations": needsYou,
  };
});
afterEach(cleanup);

const posts = () => h.calls.filter((c) => c.init?.method === "POST").map((c) => JSON.parse(String(c.init!.body)));

describe("the card", () => {
  it("Needs you: the design's copy, the country and the order tip", async () => {
    render(<AdLocationsCard slug="google_ads" channelName="Google Ads" />);
    expect(await screen.findByText("Needs you")).toBeTruthy();
    const section = screen.getByRole("region", { name: "Where your ads show" });
    expect(section.textContent).toContain(
      "Across the United States for now. Most of your orders come from San Francisco, Oakland and San Jose.",
    );
    expect(screen.getByRole("button", { name: "Keep the whole country" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pick places" })).toBeTruthy();
  });

  it("Keep the whole country saves no places for THAT campaign, with the card's fingerprint", async () => {
    render(<AdLocationsCard slug="google_ads" channelName="Google Ads" />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep the whole country" }));
    await waitFor(() => expect(posts()).toEqual([{ campaign_id: "555", fingerprint: FP, places: [] }]));
  });

  it("saved: the places and the promise", async () => {
    h.routes["/api/channels/google_ads/ad-locations"] = { ...needsYou, state: "saved", places: [{ id: "1", name: "San Francisco, CA", kind: "City" }, { id: "2", name: "Oakland, CA", kind: "City" }] };
    render(<AdLocationsCard slug="google_ads" channelName="Google Ads" />);
    expect(await screen.findByText(/San Francisco, CA, Oakland, CA\. Zavi tells you if orders start coming from somewhere new\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit places" })).toBeTruthy();
  });

  it("no CGO campaign: nothing at all", async () => {
    h.routes["/api/channels/google_ads/ad-locations"] = { state: "none" };
    const { container } = render(<AdLocationsCard slug="google_ads" channelName="Google Ads" />);
    await waitFor(() => expect(h.calls.length).toBeGreaterThan(0));
    expect(container.textContent).toBe("");
  });
});

describe("the modal", () => {
  it("pre-ticks the order places, saves the founder's picks for this campaign only", async () => {
    render(<AdLocationsCard slug="google_ads" channelName="Google Ads" />);
    fireEvent.click(await screen.findByRole("button", { name: "Pick places" }));
    expect(await screen.findByText("Zavi suggested these from your orders and address.")).toBeTruthy();
    expect(screen.getByText("These places apply to this Google Ads campaign only.")).toBeTruthy();
    const save = await screen.findByRole("button", { name: "Save 2 places" });
    expect(screen.getByRole("checkbox", { name: /San Jose, CA/ }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(save);
    await waitFor(() =>
      expect(posts()).toEqual([
        {
          campaign_id: "555",
          fingerprint: FP,
          places: [
            { id: "1014221", name: "San Francisco, CA" },
            { id: "1014044", name: "Oakland, CA" },
          ],
        },
      ]),
    );
  });

  it("unticking everything saves the whole country", async () => {
    render(<AdLocationsCard slug="google_ads" channelName="Google Ads" />);
    fireEvent.click(await screen.findByRole("button", { name: "Pick places" }));
    await screen.findByRole("button", { name: "Save 2 places" });
    fireEvent.click(screen.getByRole("checkbox", { name: /San Francisco, CA/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Oakland, CA/ }));
    expect(screen.getByText("Nothing picked: ads show across the United States.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save whole country" })).toBeTruthy();
  });

  it("the CGO note's link (?channel=<slug>&locations=1) opens the picker once", async () => {
    h.location = "/workspace?tab=channels&channel=google_ads&locations=1";
    render(<AdLocationsCard slug="google_ads" channelName="Google Ads" />);
    expect(await screen.findByRole("heading", { name: "Where your ads show" })).toBeTruthy();
    expect(h.location).toBe("/workspace?tab=channels&channel=google_ads");
  });
});

describe("words", () => {
  it("country article and lists", () => {
    expect(countryArticle("United States")).toBe("the ");
    expect(countryArticle("Canada")).toBe("");
    expect(joinAnd(["A"])).toBe("A");
    expect(joinAnd(["A", "B", "C"])).toBe("A, B and C");
  });
});
