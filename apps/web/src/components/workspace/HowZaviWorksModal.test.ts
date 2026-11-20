import { describe, it, expect } from "vitest";
import { howZaviConnectDestination } from "./HowZaviWorksModal";

describe("howZaviConnectDestination", () => {
  it("sends 'Connect Slack' to the chat-surface destination", () => {
    expect(howZaviConnectDestination("connectSlack")).toBe("messaging");
  });

  it("sends 'Connect tools' to Toolkit, where data connectors live", () => {
    expect(howZaviConnectDestination("connect")).toBe("brain");
  });

  it("never routes a connect CTA to settings again", () => {
    for (const action of ["connectSlack", "connect"] as const) {
      expect(howZaviConnectDestination(action)).not.toBe("settings");
    }
  });
});
