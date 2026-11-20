// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const compact = { value: true };
vi.mock("@/lib/responsive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/responsive")>()),
  useIsCompact: () => compact.value,
  useMediaMatch: () => compact.value,
}));

vi.mock("../agent/PerformanceMarketerDashboard", () => ({
  PerformanceMarketerDashboard: () => <div data-testid="paid" />,
}));
vi.mock("../agent/SeoGeoDashboard", () => ({
  SeoGeoDashboard: () => <div data-testid="seo" />,
}));
vi.mock("../agent/GeoDashboard", () => ({
  GeoDashboard: () => <div data-testid="geo" />,
}));
vi.mock("../agent/XAgentDashboard", () => ({
  XAgentDashboard: () => <div data-testid="x" />,
}));
vi.mock("../agent/AdsManagerDateRangePicker", () => ({
  AdsManagerDateRangePicker: () => <div data-testid="range" />,
  presetRange: () => ({ start: "2026-09-01", end: "2026-09-07" }),
  resolveWindow: () => ({ start: "2026-09-01", end: "2026-09-07" }),
}));

vi.mock("./useChannelLocks", () => ({
  useChannelLocks: () => ({
    meta_ads: null,
    google_ads: null,
    seo: null,
    geo: null,
    reddit_organic: null,
    x_organic: null,
  }),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role: "owner", treeAgents: [] }),
}));

import { CompactHeaderSlotProvider } from "./compactHeaderSlot";
import { View360 } from "./View360";

function renderWithSlot(node: React.ReactNode) {
  const slot = document.createElement("div");
  document.body.append(slot);
  const utils = render(
    <CompactHeaderSlotProvider element={slot}>{node}</CompactHeaderSlotProvider>,
  );
  return { slot, ...utils };
}

afterEach(() => {
  cleanup();
  compact.value = true;
  document.body.innerHTML = "";
});

describe("the phone header slot", () => {
  it("moves Refresh and the date picker into the header instead of a row of their own", () => {
    const { slot } = renderWithSlot(<View360 />);
    expect(within(slot).getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(within(slot).getByTestId("range")).toBeTruthy();
  });

  it("leaves exactly one copy of each control in the document", () => {
    renderWithSlot(<View360 />);
    expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(1);
    expect(screen.getAllByTestId("range")).toHaveLength(1);
  });

  it("keeps the controls in place when there is no header to lift them into", () => {
    render(<View360 />);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByTestId("range")).toBeTruthy();
  });

  it("does not lift from a tab that is mounted but off screen", () => {
    const { slot } = renderWithSlot(<View360 active={false} />);
    expect(within(slot).queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("leaves the desktop header alone", () => {
    compact.value = false;
    const { slot } = renderWithSlot(<View360 />);
    expect(within(slot).queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });
});
