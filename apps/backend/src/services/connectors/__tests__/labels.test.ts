import { describe, it, expect } from "vitest";

import { connectorLabel } from "@/services/connectors/labels";

describe("connectorLabel", () => {
  it("resolves a Pipedream app slug to its display name", () => {
    expect(connectorLabel("pipedream.posthog")).toContain("PostHog");
  });

  it("resolves a Composio toolkit slug via the composio helper/override map", () => {
    expect(connectorLabel("composio.sentry")).toBe("Sentry");
    expect(connectorLabel("composio.hubspot")).toBe("HubSpot");
  });

  it("maps a first-party slug to its catalog label", () => {
    expect(connectorLabel("github")).toBe("GitHub");
    expect(connectorLabel("meta_ads")).toBe("Meta Ads");
    expect(connectorLabel("operator_db")).toBe("Your database");
  });

  it("title-cases the last segment for an unknown slug (no throw)", () => {
    expect(() => connectorLabel("some_unknown_connector")).not.toThrow();
    expect(connectorLabel("some_unknown_connector")).toBe("Some Unknown Connector");
    expect(connectorLabel("pipedream.acme_widgets")).toBe("Acme Widgets");
  });

  it("never throws on empty / nullish input", () => {
    expect(() => connectorLabel("")).not.toThrow();
    // @ts-expect-error — exercising the defensive nullish guard.
    expect(() => connectorLabel(undefined)).not.toThrow();
  });
});
