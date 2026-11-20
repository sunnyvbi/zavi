import { describe, it, expect } from "vitest";
import { CHANNELS } from "@zavi/shared";
import { joinChannelStates } from "@/services/channels/state";
import { assembleChannels, type LatestRun } from "../list";

const base = { latestRun: new Map<string, LatestRun>(), runsAvailable: true, now: Date.parse("2026-10-07T00:00:00.000Z"), staleMs: 7_200_000 };
const email = (linked: string[]) =>
  assembleChannels({ ...base, linked: new Set(linked), states: joinChannelStates([{ channel_slug: "email_marketing" }]) }).find((c) => c.channel_slug === "email_marketing")!;

describe("linked_connectors on the channel list", () => {
  it("the channel declares the two email tools first, then Gmail, then the email key", () => {
    expect(CHANNELS.find((c) => c.slug === "email_marketing")?.connectors).toEqual(["composio.mailchimp", "composio.klaviyo", "composio.gmail", "email"]);
  });

  it("a Gmail-only workspace is connected, and the list shows Mailchimp and Klaviyo are not linked", () => {
    const c = email(["composio.gmail"]);
    expect(c.connected).toBe(true);
    expect(c.linked_connectors).toEqual(["composio.gmail"]);
  });

  it("a workspace with only the email key is connected through it alone", () => {
    expect(email(["email"])).toMatchObject({ connected: true, linked_connectors: ["email"] });
  });

  it("nothing linked: not connected, and an empty list", () => {
    expect(email([])).toMatchObject({ connected: false, linked_connectors: [] });
  });

  it("a connector the channel does not declare never appears", () => {
    expect(email(["composio.mailchimp", "meta_ads", "stripe"]).linked_connectors).toEqual(["composio.mailchimp"]);
  });

  it("a linked email tool makes the channel one Zavi can act on", () => {
    expect(email(["composio.klaviyo"]).delivery_mode).toBe("execute");
  });

  it("every channel serves the list as a subset of what it declares", () => {
    const out = assembleChannels({ ...base, linked: new Set(["google_analytics", "meta_ads", "composio.gmail"]), states: joinChannelStates([{ channel_slug: "seo" }]) });
    for (const c of out) {
      expect(c.linked_connectors.every((s) => c.connectors.includes(s)), c.channel_slug).toBe(true);
      expect(c.connected).toBe(c.linked_connectors.length > 0);
    }
  });
});
