// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { FindFilterBar, NO_FILTERS, type FindFilters } from "./FindFilters";
import type { CreatorFilterLabels, CreatorFilterOptions } from "@/lib/creator-storefront";

const options: CreatorFilterOptions = {
  platforms: [],
  niches: [{ value: "fitness", label: "fitness" }],
  lanes: [],
  max_price_cents: [],
  max_delivery_days: [],
  min_followers: [],
  countries: [],
};

const pill = (name: string) => ({ name, any: `Any ${name.toLowerCase()}` });
const labels: CreatorFilterLabels = {
  platforms: pill("Platform"),
  keyword: { name: "Keyword or niche", placeholder: "Search" },
  niches: { name: "Niches" },
  lanes: pill("Content type"),
  max_price_cents: pill("Price"),
  max_delivery_days: pill("Delivery"),
  min_followers: { ...pill("Followers"), note: "Self-reported" },
  countries: pill("Location"),
  order: { name: "Sort" },
};

let last: FindFilters = NO_FILTERS;
function Harness() {
  const [f, setF] = useState<FindFilters>(NO_FILTERS);
  last = f;
  return (
    <FindFilterBar value={f} onChange={setF} options={options} orders={[]} shown={0} loading={false} orderLabel="Newest first" neutralityNote={null} labels={labels} notes={null} ready />
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("keyword debounce", () => {
  it("keeps a niche picked while the keyword is still pending", () => {
    vi.useFakeTimers();
    render(<Harness />);
    const input = screen.getByLabelText("Keyword or niche");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "yoga" } });
    fireEvent.click(screen.getByRole("button", { name: "fitness" }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(last.keyword).toBe("yoga");
    expect(last.niches).toEqual(["fitness"]);
  });
});

describe("FindFilterBar count", () => {
  it("says the count covers only the creators loaded when a local filter ran over part of the list", () => {
    render(<FindFilterBar value={NO_FILTERS} onChange={() => {}} options={options} orders={[]} shown={2} scanned={100} loading={false} orderLabel="" neutralityNote={null} labels={labels} notes={null} ready />);
    expect(screen.getByText("2 creators in the first 100 loaded")).toBeTruthy();
  });

  it("is the plain count when the whole list was read", () => {
    render(<FindFilterBar value={NO_FILTERS} onChange={() => {}} options={options} orders={[]} shown={2} loading={false} orderLabel="" neutralityNote={null} labels={labels} notes={null} ready />);
    expect(screen.getByText("2 creators")).toBeTruthy();
  });
});
