// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ChannelTabBar } from "./ChannelTabBar";
import type { ChannelTabKey } from "./ChannelTabs";
import { ArtifactTypeTabs } from "../artifacts/ArtifactTypeTabs";
import type { ArtifactFilter } from "../artifacts/types";

const left = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft");
const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get(this: HTMLElement) {
      const tabs = this.parentElement ? Array.from(this.parentElement.querySelectorAll("[role=tab]")) : [];
      return tabs.indexOf(this) * 120 + 8;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return (this.textContent ?? "").length * 10;
    },
  });
});
afterAll(() => {
  if (left) Object.defineProperty(HTMLElement.prototype, "offsetLeft", left);
  if (width) Object.defineProperty(HTMLElement.prototype, "offsetWidth", width);
});
afterEach(cleanup);

const style = () => (screen.getByTestId("tab-indicator") as HTMLElement).style;

function Channel() {
  const [tab, setTab] = useState<ChannelTabKey>("overview");
  return (
    <ChannelTabBar
      tabs={[
        ["overview", "Overview"],
        ["settings", "Settings"],
      ]}
      active={tab}
      onSelect={setTab}
      count={0}
      label="Email campaigns"
    />
  );
}

function Artifacts() {
  const [value, setValue] = useState<ArtifactFilter>("all");
  return <ArtifactTypeTabs value={value} onChange={setValue} />;
}

describe("the sliding tab indicator", () => {
  it("marks the selected channel tab as a raised pill on the track, with no sliding underline", () => {
    render(<Channel />);
    expect(screen.queryByTestId("tab-indicator")).toBeNull();
    const overview = screen.getByRole("tab", { name: "Overview" });
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(overview.className).toContain("shadow-ca-sm");
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByRole("tab", { name: "Settings" }).className).toContain("shadow-ca-sm");
    expect(screen.getByRole("tab", { name: "Overview" }).className).not.toContain("shadow-ca-sm");
  });

  it("slides one pill behind the artifact filters instead of repainting each button", () => {
    render(<Artifacts />);
    const pill = screen.getByTestId("tab-indicator");
    expect(pill.getAttribute("data-variant")).toBe("pill");
    expect(style().transform).toBe("translateX(8px)");
    fireEvent.click(screen.getByRole("tab", { name: "Websites" }));
    expect(style().transform).toBe(`translateX(${3 * 120 + 8}px)`);
    expect(style().width).toBe("80px");
    for (const tab of screen.getAllByRole("tab")) expect(tab.className).not.toMatch(/(^|\s)bg-ink(\s|$)/);
  });
});
