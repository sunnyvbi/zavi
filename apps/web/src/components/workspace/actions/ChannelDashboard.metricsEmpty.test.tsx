// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { connectorNames } from "./ChannelDashboard";
import * as dashboard from "./ChannelDashboard";

describe("a channel with no numbers says nothing about numbers", () => {
  it("no longer ships the 'Nothing has written numbers here yet' sentence at all", () => {
    expect("MetricsEmpty" in dashboard).toBe(false);
  });

  it("still names connectors, and falls back to 'an account' when no slug is known", () => {
    expect(connectorNames([])).toBe("an account");
    expect(connectorNames(["google_analytics"])).not.toBe("an account");
  });
});
