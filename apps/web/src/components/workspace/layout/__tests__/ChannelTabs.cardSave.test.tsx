// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChannelSettingsTab } from "../ChannelTabs";
import { PLATFORMS } from "../../actions/platforms";
import { announceChannelSettingsChanged } from "@/lib/workspace/onTabReturn";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const flush = async (ticks = 16) => {
  await act(async () => {
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
  });
};

let server: Record<string, { item: string }[]> = {};

beforeEach(() => {
  server = { deal_value: [] };
  apiFetch.mockReset();
  apiFetch.mockImplementation(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ fields: server }) }));
});

afterEach(() => cleanup());

const deal = () => screen.getByLabelText("What one new customer is worth in year one") as HTMLInputElement;

describe("the settings tab follows a value a card saved", () => {
  it("must catch: an open settings tab shows the value a card saved, without a reload", async () => {
    render(<ChannelSettingsTab slug="linkedin_ads" fields={PLATFORMS.linkedin_ads.settings ?? []} />);
    await flush();
    expect(deal().value).toBe("");
    server = { deal_value: [{ item: "2250" }] };
    act(() => announceChannelSettingsChanged());
    await flush();
    expect(deal().value.replace(/,/g, "")).toBe("2250");
  });

  it("must catch: a field the founder is still editing is not overwritten by the reread", async () => {
    server = { deal_value: [], landing_page: [] };
    render(<ChannelSettingsTab slug="linkedin_ads" fields={PLATFORMS.linkedin_ads.settings ?? []} />);
    await flush();
    const landing = screen.getByLabelText("Where a LinkedIn click lands") as HTMLInputElement;
    fireEvent.change(landing, { target: { value: "https://example.com/demo" } });
    server = { deal_value: [{ item: "2250" }], landing_page: [] };
    act(() => announceChannelSettingsChanged());
    await flush();
    expect(deal().value.replace(/,/g, "")).toBe("2250");
    expect((screen.getByLabelText("Where a LinkedIn click lands") as HTMLInputElement).value).toBe("https://example.com/demo");
  });
});
