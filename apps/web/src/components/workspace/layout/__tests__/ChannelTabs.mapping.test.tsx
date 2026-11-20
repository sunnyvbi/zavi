// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChannelSettingsTab } from "../ChannelTabs";
import { PLATFORMS } from "../../actions/platforms";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const flush = async (ticks = 16) => {
  await act(async () => {
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
  });
};

function stubApi(fields: Record<string, unknown[]>) {
  apiFetch.mockImplementation((_path: string, init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (init?.method === "PUT" ? {} : { fields }),
    }),
  );
}

const fields = PLATFORMS.meta_ads.settings ?? [];

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("Meta Ads metric sources table", () => {
  it("lists the four outcome metrics, each defaulting to Meta Ads, and not spend or CTR", async () => {
    stubApi({});
    render(<ChannelSettingsTab slug="meta_ads" fields={fields} />);
    await flush();
    for (const label of ["Cost per conversion", "Conversions", "Conversion value", "ROAS"]) {
      const select = screen.getByLabelText(`Source for ${label}`) as HTMLSelectElement;
      expect(select.value).toBe("");
      expect(select.selectedOptions[0].textContent).toBe("Meta Ads");
    }
    expect(screen.queryByLabelText("Source for Spend")).toBeNull();
    expect(screen.queryByLabelText("Source for Click-through rate")).toBeNull();
  });

  it("shows a saved source and saves only the rows that were set", async () => {
    stubApi({ metric_sources: [{ item: "conv_value", item_type: "stripe" }] });
    render(<ChannelSettingsTab slug="meta_ads" fields={fields} />);
    await flush();
    expect((screen.getByLabelText("Source for Conversion value") as HTMLSelectElement).value).toBe("stripe");

    fireEvent.change(screen.getByLabelText("Source for Conversions"), { target: { value: "database" } });
    fireEvent.change(screen.getByLabelText("Source for Conversion value"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();

    const put = apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    expect(put?.[0]).toBe("/api/channels/meta_ads/settings/metric_sources");
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({
      items: [{ item: "conversions", item_type: "database" }],
    });
  });
});
