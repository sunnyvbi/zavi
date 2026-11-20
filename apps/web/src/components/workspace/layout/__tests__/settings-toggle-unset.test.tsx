// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { ChannelSettingsTab } from "../ChannelTabs";
import { PLATFORMS } from "../../actions/platforms";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const flush = async () => {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
};

afterEach(cleanup);

describe("an unanswered toggle shows what the run will do", () => {
  it("Google Ads' pause switch reads on when nothing is saved, and the first press saves off", async () => {
    apiFetch.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method === "PUT" ? ok({ fields: {} }) : ok({ fields: {}, prefill: {} }),
    );
    const fields = (PLATFORMS.google_ads.settings ?? []).filter((f) => f.id === "maypause");
    render(<ChannelSettingsTab slug="google_ads" fields={fields} />);
    await act(flush);
    const sw = screen.getByRole("switch", { name: "Pause a losing campaign" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Yes, propose it with the numbers")).toBeTruthy();
    await act(async () => {
      fireEvent.click(sw);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
      await flush();
    });
    const put = apiFetch.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(put?.[1]?.body ?? "{}")).toEqual({ items: [{ item: "off" }] });
  });
});
