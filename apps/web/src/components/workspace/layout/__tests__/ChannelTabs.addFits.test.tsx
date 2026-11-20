// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChannelSettingsTab } from "../ChannelTabs";
import { PLATFORMS } from "../../actions/platforms";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

afterEach(cleanup);

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
  });
};

describe("a list setting's Add row on a narrow card", () => {
  it.each([false, true])("lets the input shrink and wraps Add inside the card (bare=%s)", async (bare) => {
    apiFetch.mockImplementation(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ fields: {} }) }));
    const fields = PLATFORMS.pinterest_organic.settings!;
    render(<ChannelSettingsTab slug="pinterest_organic" fields={fields} bare={bare} />);
    await flush();
    const input = screen.getByLabelText("Add to Pinterest accounts in your niche");
    const add = screen.getByRole("button", { name: "Add" });
    const form = input.closest("form")!;
    expect(form.contains(add)).toBe(true);
    expect(form.className.split(" ")).toContain("flex-wrap");
    const cls = input.className.split(" ");
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("flex-1");
    expect(cls).toContain("basis-40");
    expect(add.className.split(" ")).toContain("shrink-0");
  });
});
