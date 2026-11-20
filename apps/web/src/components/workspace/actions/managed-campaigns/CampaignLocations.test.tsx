// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CampaignLocation } from "@zavi/shared";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
import { CampaignLocations } from "./CampaignLocations";

beforeEach(() => api.mockReset());
afterEach(() => { cleanup(); api.mockReset(); });
function Picker() {
  const [selected, setSelected] = useState<CampaignLocation[]>([]);
  return <><CampaignLocations apiBase="/ads" label="Include locations" selected={selected} onChange={setSelected} /><output>{selected.map(p => p.id).join(",")}</output></>;
}
it("distinguishes same-name provider regions and markets and preserves each selected identity", async () => {
  api.mockResolvedValue({ locations: [
    { id: "2000075", name: "New York, United States", type: "region", region_code: "US-NY", country_code: "US", parent_country: "United States" },
    { id: "3000001", name: "New York, United States", type: "market", country_code: "US", parent_country: "United States" },
    { id: "9331802", name: "NE27, New York, ENG, United Kingdom", type: "postal_code", country_code: "GB", region_code: "NE27", parent_country: "United Kingdom" },
  ] });
  render(<Picker />);
  fireEvent.change(screen.getByLabelText("Include locations search"), { target: { value: "New York" } });
  expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
  const region = await screen.findByRole("option", { name: /New York, United States region · US-NY · United States/ });
  expect(screen.getByRole("option", { name: /New York, United States market · United States/ })).toBeTruthy();
  expect(screen.getByRole("option", { name: /NE27, New York, ENG, United Kingdom postal code · NE27 · United Kingdom/ })).toBeTruthy();
  fireEvent.click(region);
  const chip = screen.getByRole("button", { name: "Remove New York, United States (region · US-NY · United States)" }).closest("li")!;
  expect(within(chip).getByText("region · US-NY · United States")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("2000075");
  fireEvent.click(screen.getByRole("option", { name: /New York, United States market · United States/ }));
  expect(screen.getByRole("status").textContent).toBe("2000075,3000001");
  expect(region.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(within(chip).getByRole("button"));
  expect(screen.getByRole("status").textContent).toBe("3000001");
});
it("keeps older name-only results selectable without inventing geographic types", async () => {
  api.mockResolvedValue({ locations: [{ id: "old", name: "California, United States" }] });
  render(<Picker />);
  fireEvent.change(screen.getByLabelText("Include locations search"), { target: { value: "California" } });
  fireEvent.click(await screen.findByRole("option", { name: "California, United States" }));
  expect(screen.getByRole("button", { name: "Remove California, United States" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("old");
});
it("asks for places only after typing pauses, once per burst, and never shows a reply to an older query", async () => {
  const replies: Record<string, (v: unknown) => void> = {};
  api.mockImplementation((...args: unknown[]) => new Promise(resolve => { replies[new URLSearchParams(String(args[0]).split("?")[1]).get("q")!] = resolve; }));
  render(<Picker />);
  const input = screen.getByLabelText("Include locations search");
  fireEvent.change(input, { target: { value: "Ca" } });
  fireEvent.change(input, { target: { value: "Can" } });
  await act(() => new Promise(r => setTimeout(r, 350)));
  expect(api.mock.calls.map(([p]) => new URLSearchParams(String(p).split("?")[1]).get("q"))).toEqual(["Can"]);
  fireEvent.change(input, { target: { value: "Cali" } });
  await act(() => new Promise(r => setTimeout(r, 350)));
  await act(async () => { replies.Can({ locations: [{ id: "ca", name: "Canada" }] }); await new Promise(r => setTimeout(r, 20)); });
  expect(screen.queryByRole("option", { name: "Canada" })).toBeNull();
  expect(screen.getByText("Searching…")).toBeTruthy();
  await act(async () => { replies.Cali({ locations: [{ id: "cal", name: "California, United States" }] }); });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  await screen.findByRole("option", { name: "California, United States" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(document.querySelector("output")!.textContent).toBe("cal");
  fireEvent.blur(input);
  expect(screen.queryByRole("listbox")).toBeNull();
});
function CappedPicker({ start, max }: { start: number; max: number }) {
  const [selected, setSelected] = useState<CampaignLocation[]>(Array.from({ length: start }, (_, i) => ({ id: `urn:li:geo:${i}`, name: `State ${i}, United States` })));
  return <><CampaignLocations apiBase="/ads" label="Include locations" selected={selected} onChange={setSelected} max={max} /><output>{selected.length}</output></>;
}
it("stops at the campaign's place limit with a clear way out, instead of letting the founder build a list the server refuses", async () => {
  api.mockResolvedValue({ locations: [{ id: "urn:li:geo:dc", name: "District of Columbia, United States" }, { id: "urn:li:geo:0", name: "State 0, United States" }] });
  render(<CappedPicker start={50} max={50} />);
  expect(screen.getByText("A campaign can take up to 50 places here. Remove one to add another.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Include locations search"), { target: { value: "District" } });
  const dc = await screen.findByRole("option", { name: /District of Columbia, United States/ });
  expect(dc.getAttribute("aria-disabled")).toBe("true");
  expect(dc.textContent).toContain("A campaign can take up to 50 places here. Remove one to add another.");
  fireEvent.click(dc);
  const input = screen.getByLabelText("Include locations search");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(document.querySelector("output")!.textContent).toBe("49");
  fireEvent.click(screen.getByRole("option", { name: /District of Columbia, United States/ }));
  expect(document.querySelector("output")!.textContent).toBe("50");
  expect(screen.getByRole("button", { name: "Remove District of Columbia, United States" })).toBeTruthy();
  const state0 = screen.getByRole("option", { name: /State 0, United States/ });
  expect(state0.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(state0);
  expect(document.querySelector("output")!.textContent).toBe("50");
});
it("says how many places to remove when a list already holds more than the limit", () => {
  render(<CappedPicker start={52} max={50} />);
  expect(screen.getByText("This list has 52 places, and a campaign can take up to 50. Remove 2 to continue.")).toBeTruthy();
});
