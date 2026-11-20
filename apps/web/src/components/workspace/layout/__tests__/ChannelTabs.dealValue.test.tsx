import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChannelSettingsTab } from "../ChannelTabs";
import { PLATFORMS } from "../../actions/platforms";
import { parseAmount } from "../moneyInput";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const flush = async (ticks = 16) => {
  await act(async () => {
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
  });
};

const respond = (ok: boolean, status: number, body: unknown) =>
  Promise.resolve({ ok, status, json: async () => body });

let saved: Record<string, { item: string }[]> = {};

beforeEach(() => {
  saved = { deal_value: [{ item: "5000" }] };
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const id = String(path).split("/").pop()!;
      const items = (JSON.parse(String(init.body)) as { items: { item: string }[] }).items;
      saved = { ...saved, [id]: items };
      return respond(true, 200, { fields: { [id]: items } });
    }
    return respond(true, 200, { fields: saved });
  });
});

afterEach(() => cleanup());

const dealPuts = () =>
  apiFetch.mock.calls
    .filter(([path, init]) => (init as RequestInit | undefined)?.method === "PUT" && String(path).endsWith("/deal_value"))
    .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { items: { item: string }[] }).items);

const input = () => screen.getByLabelText("What one new customer is worth in year one") as HTMLInputElement;

async function typeAndSave(value: string) {
  render(<ChannelSettingsTab slug="linkedin_ads" fields={PLATFORMS.linkedin_ads.settings ?? []} />);
  await flush();
  fireEvent.change(input(), { target: { value } });
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await flush();
}

describe("the deal value accepts the ways people type money", () => {
  for (const [typed, sent] of [
    ["12,000", "12000"],
    ["$12000", "12000"],
    ["$12,000.50", "12000.5"],
    ["US$ 1,250,000", "1250000"],
    ["12k", "12000"],
  ] as const) {
    it(`saves "${typed}" as ${sent}, never as an empty value`, async () => {
      await typeAndSave(typed);
      expect(dealPuts()).toEqual([[{ item: sent }]]);
      expect(saved.deal_value).toEqual([{ item: sent }]);
      expect(input().value).toBe(sent);
      expect(screen.getByText(/^Saved\./)).toBeTruthy();
    });
  }
});

describe("an amount it cannot read is refused and the saved value is kept", () => {
  for (const typed of ["twelve thousand", "12,00", "-500", "1.2.3"]) {
    it(`refuses "${typed}" without sending anything`, async () => {
      await typeAndSave(typed);
      expect(dealPuts()).toEqual([]);
      expect(saved.deal_value).toEqual([{ item: "5000" }]);
      expect(screen.queryByText(/^Saved\./)).toBeNull();
      expect(screen.getByText(/can't read/)).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toContain("Type a number like 12000");
      expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(false);
    });
  }

  it("still clears the value when the founder empties the field on purpose", async () => {
    await typeAndSave("");
    expect(dealPuts()).toEqual([[]]);
  });
});

describe("the deal value is shown as US dollars", () => {
  it("labels the field with US$, not a bare $", async () => {
    render(<ChannelSettingsTab slug="linkedin_ads" fields={PLATFORMS.linkedin_ads.settings ?? []} />);
    await flush();
    expect(screen.getByText("US$")).toBeTruthy();
  });
});

describe("parseAmount", () => {
  it("honours a field maximum", () => {
    expect(parseAmount("150", 100)).toBeNull();
    expect(parseAmount("100", 100)).toBe("100");
  });
});
