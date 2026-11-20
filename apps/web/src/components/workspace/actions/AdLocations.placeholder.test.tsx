// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ release: null as null | ((body: unknown) => void) }));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        h.release = (body: unknown) => resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
  ),
}));
vi.mock("../navigation/workspaceRoutes", () => ({
  readWorkspaceLocation: () => "/workspace?tab=channels&channel=meta_ads",
  replaceWorkspaceLocation: () => {},
}));

import { AD_LOCATIONS_PLACEHOLDER_DELAY_MS, AdLocationsCard } from "./AdLocations";

const saved = {
  state: "saved",
  channel: "meta_ads",
  campaign: { id: "555", name: "Zavi · Coffee" },
  country: { code: "US", name: "United States" },
  places: [{ id: "2840", name: "United States", kind: "Country" }],
  targeting: "single",
  ad_groups: 0,
  pending: false,
  last_error: null,
  order_cities: [],
  fingerprint: "a".repeat(64),
};

beforeEach(() => {
  vi.useFakeTimers();
  h.release = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("a fast 'no campaign' answer never shows a placeholder", async () => {
  const { container } = render(<AdLocationsCard slug="meta_ads" channelName="Meta Ads" />);
  await act(async () => {
    h.release?.({ state: "none" });
  });
  await act(async () => {
    vi.advanceTimersByTime(AD_LOCATIONS_PLACEHOLDER_DELAY_MS + 50);
  });
  expect(screen.queryByTestId("ad-locations-loading")).toBeNull();
  expect(container.innerHTML).toBe("");
});

it("a slow read holds the card's place, then the card replaces it", async () => {
  render(<AdLocationsCard slug="meta_ads" channelName="Meta Ads" />);
  expect(screen.queryByTestId("ad-locations-loading")).toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(AD_LOCATIONS_PLACEHOLDER_DELAY_MS + 50);
  });
  expect(screen.getByTestId("ad-locations-loading")).toBeTruthy();
  await act(async () => {
    h.release?.(saved);
  });
  expect(screen.queryByTestId("ad-locations-loading")).toBeNull();
  expect(screen.getByLabelText("Where your ads show")).toBeTruthy();
});
