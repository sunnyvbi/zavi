// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/api", () => ({ apiFetch: h.fetch }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-1" }));

import { adThumbnail } from "./campaignMedia";

const AD_IMAGE = "https://media.licdn.com/dms/image/v2/ad-own/0/1/hero.png";
const SET_IMAGE = "https://media.licdn.com/dms/image/v2/set/0/1/set.png";
const answer = (thumbnails: Record<string, string[]>) => ({ ok: true, status: 200, json: async () => ({ thumbnails }) });

let seq = 0;
const ids = () => {
  seq += 1;
  return { ad: `16776550${seq}`, set: `92456542${seq}`, other: `92466453${seq}` };
};

beforeEach(() => h.fetch.mockReset());
afterEach(() => cleanup());

describe("a LinkedIn ad row's preview", () => {
  it("asks at ad level for the row's ad sets and shows the image keyed by that ad", async () => {
    const id = ids();
    h.fetch.mockResolvedValue(answer({ [id.ad]: [AD_IMAGE], [id.set]: [SET_IMAGE] }));
    render(adThumbnail("linkedin_ads", id.ad, "Ad_1_5Nov2026", `${id.set},${id.other}`, id.set));
    const img = await screen.findByRole("img", { name: "Ad_1_5Nov2026 creative" });
    expect(img.getAttribute("src")).toBe(AD_IMAGE);
    const url = new URL(h.fetch.mock.calls[0][0], "http://x");
    expect(url.searchParams.get("level")).toBe("ad");
    expect(url.searchParams.get("channel")).toBe("linkedin_ads");
    expect(url.searchParams.get("campaign_ids")).toBe([id.set, id.other].sort().join(","));
  });

  it("must catch: a backend that predates level=ad answers keyed by ad set, and the ad shows its ad set's image instead of media unavailable", async () => {
    const id = ids();
    h.fetch.mockResolvedValue(answer({ [id.set]: [SET_IMAGE], [id.other]: [] }));
    render(adThumbnail("linkedin_ads", id.ad, "Ad_1_5Nov2026", `${id.set},${id.other}`, id.set));
    const img = await screen.findByRole("img", { name: "Ad_1_5Nov2026 creative" });
    expect(img.getAttribute("src")).toBe(SET_IMAGE);
    expect(screen.queryByRole("img", { name: /media unavailable/ })).toBeNull();
  });

  it("an ad the backend read with no image keeps the clean media-unavailable icon and never borrows another key's image", async () => {
    const id = ids();
    h.fetch.mockResolvedValue(answer({ [id.ad]: [], [id.set]: [SET_IMAGE] }));
    render(adThumbnail("linkedin_ads", id.ad, "Text ad", `${id.set}`, id.set));
    await waitFor(() => expect(screen.getByRole("img", { name: "Text ad: media unavailable" })).toBeTruthy());
    expect(screen.queryByRole("img", { name: "Text ad creative" })).toBeNull();
  });

  it("must catch: while the image file is still downloading the slot shows a loading block, never an empty dark gap, and the image only shows once it has loaded", async () => {
    const id = ids();
    h.fetch.mockResolvedValue(answer({ [id.ad]: [AD_IMAGE] }));
    const { container } = render(adThumbnail("linkedin_ads", id.ad, "Ad_1_5Nov2026", `${id.set}`, id.set));
    const img = await screen.findByRole("img", { name: "Ad_1_5Nov2026 creative" });
    expect(img.getAttribute("data-loaded")).toBe("false");
    expect(img.className).toContain("opacity-0");
    expect(screen.getByTestId("thumbnail-pending").querySelector(".animate-pulse")).not.toBeNull();
    expect((container.firstElementChild as HTMLElement).className).toContain("ring-1");
    fireEvent.load(img);
    await waitFor(() => expect(screen.queryByTestId("thumbnail-pending")).toBeNull());
    expect(img.getAttribute("data-loaded")).toBe("true");
    expect(img.className).toContain("opacity-100");
  });
});
