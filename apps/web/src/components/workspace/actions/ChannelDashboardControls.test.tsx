// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/responsive", () => ({ useIsCompact: () => false, useMediaMatch: () => false }));

import { ChannelDashboardControls } from "./ChannelDashboardControls";
import { ChannelPageProvider } from "../layout/channelPage";

afterEach(cleanup);

const ranges = [
  { id: "last_7", label: "Last 7 days", days: 7 },
  { id: "last_30", label: "Last 30 days", days: 30 },
];

const controls = (over: Partial<Parameters<typeof ChannelDashboardControls>[0]> = {}) => (
  <ChannelDashboardControls ranges={ranges} range={ranges[1]} pickedId="last_30" onPick={() => {}} onRefresh={() => {}} refreshing={false} scan={false} {...over} />
);

describe("the channel toolbar's range and Refresh", () => {
  it("shows a labelled Refresh button that refreshes on click", () => {
    const onRefresh = vi.fn();
    render(controls({ onRefresh }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("says it is reading while a refresh runs, and is disabled", () => {
    render(controls({ refreshing: true }));
    expect((screen.getByRole("button", { name: "Reading…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("picks a range from the listbox and closes it", () => {
    const onPick = vi.fn();
    render(controls({ onPick }));
    fireEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
    expect(screen.getByRole("option", { name: "Last 30 days" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "Last 7 days" }));
    expect(onPick).toHaveBeenCalledWith({ id: "last_7", days: 7 });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows only on the Analytics tab of a page that has one", () => {
    const page = (active: "overview" | "analytics") => (
      <ChannelPageProvider value={{ active, tabs: ["overview", "analytics", "settings"], analytics: null }}>{controls()}</ChannelPageProvider>
    );
    const { rerender } = render(page("overview"));
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    rerender(page("analytics"));
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });
});
