// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChannelHeaderAction } from "./ChannelHeaderAction";
import { platformFor } from "../actions/platforms";

beforeEach(() => {
  window.history.replaceState(null, "", "/workspace?tab=channels&channel=ugc");
});
afterEach(cleanup);

describe("ChannelHeaderAction", () => {
  it("UGC Videos declares Find creators as its header action", () => {
    expect(platformFor("ugc").headerAction).toEqual({ label: "Find creators", drawer: "find" });
  });

  it("no other channel declares one", () => {
    for (const slug of ["meta_ads", "tiktok_ads", "generated_video", "seo", "x_organic"]) {
      expect(platformFor(slug).headerAction).toBeUndefined();
    }
  });

  it("opens the Find creators drawer over the channel", () => {
    render(<ChannelHeaderAction action={{ label: "Find creators", drawer: "find" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Find creators" }));
    expect(window.location.search).toBe("?tab=channels&channel=ugc&drawer=find");
  });
});
