// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ugc } from "../actions/platforms/ugc";
import { ChannelSettingsPanels } from "../email/EmailSettingsPanels";
import { WriteBriefBlock } from "./WriteBriefBlock";

beforeEach(() => {
  window.history.replaceState(null, "", "/workspace?tab=channels&channel=ugc");
});
afterEach(cleanup);

describe("Write your own brief", () => {
  it("lives in Settings, not above the channel's next steps", () => {
    expect(ugc.topActions ?? []).toEqual([]);
    expect(ugc.settingsPanels).toContain("ugc_write_brief");
  });

  it("the Settings block opens a blank brief, never a drafted one", () => {
    render(<ChannelSettingsPanels panels={ugc.settingsPanels ?? []} />);
    expect(screen.getByRole("heading", { name: "Write your own brief" })).toBeTruthy();
    expect(screen.getByText(/Zavi drafts one for you instead/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Write your own brief" }));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("drawer")).toBe("brief");
    expect(params.get("brief")).toBeNull();
    expect(params.get("channel")).toBe("ugc");
  });

  it("renders on its own with one button", () => {
    render(<WriteBriefBlock />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
