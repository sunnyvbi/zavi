// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { ChannelSettingsTab } from "../ChannelTabs";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const flush = async () => {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
};

afterEach(cleanup);

describe("a settings choice can be cleared", () => {
  it("a second press on the picked option clears it and saves no value", async () => {
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "PUT") return ok({ fields: {} });
      return ok({ fields: { on_camera: [{ id: "1", item: "voice_screen" }] }, prefill: {} });
    });
    render(
      <ChannelSettingsTab
        slug="youtube_organic"
        fields={[
          {
            kind: "choice",
            id: "on_camera",
            label: "Who can be on camera",
            options: [
              { value: "face", label: "Someone will appear on camera" },
              { value: "voice_screen", label: "Voiceover and screen recording only" },
            ],
          },
        ]}
      />,
    );
    await act(flush);
    const picked = screen.getByRole("button", { name: "Voiceover and screen recording only" });
    expect(picked.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      fireEvent.click(picked);
    });
    expect(picked.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
      await flush();
    });
    const put = apiFetch.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put?.[0]).toBe("/api/channels/youtube_organic/settings/on_camera");
    expect(JSON.parse(put?.[1]?.body ?? "{}")).toEqual({ items: [] });
  });
});
