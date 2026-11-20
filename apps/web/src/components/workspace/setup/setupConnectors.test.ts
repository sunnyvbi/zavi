import { describe, it, expect, vi } from "vitest";
vi.mock("@/components/workspace/build/existingProduct", () => ({ isZaviManagedGithubLogin: (l?: string | null) => l === "Praxis-build" }));
import { TOP_CONNECTORS, MESSAGING, filterConnectors, isConnected, connectedNames } from "./setupConnectors";

describe("setup connectors", () => {
  it("is the spec's top tiles, in the spec's order", () => {
    expect(TOP_CONNECTORS.map((c) => c.name)).toEqual([
      "Meta Ads", "Google Ads", "LinkedIn Ads",
      "X Ads", "Reddit Ads", "TikTok Ads", "Microsoft Ads", "Pinterest Ads", "Snapchat Ads", "Spotify Ads",
      "Google Analytics", "Search Console", "Instagram", "LinkedIn", "X",
      "Stripe", "Your database",
      "TikTok", "YouTube", "SendGrid", "Mailchimp", "Klaviyo", "Shopify", "HubSpot", "PostHog", "Supabase", "GitHub", "Microsoft Teams", "Salesforce",
    ]);
    expect(MESSAGING.map((c) => c.slug)).toEqual(["whatsapp", "slack", "telegram"]);
  });
  it("no tile is a Pipedream slug: catalog apps are composio.<toolkit>, SendGrid is the native email connector", () => {
    expect(TOP_CONNECTORS.some((c) => c.slug.startsWith("pipedream."))).toBe(false);
    expect(TOP_CONNECTORS.find((c) => c.name === "SendGrid")?.slug).toBe("email");
    expect(TOP_CONNECTORS.filter((c) => c.slug.startsWith("composio.")).map((c) => c.slug)).toEqual([
      "composio.youtube", "composio.mailchimp", "composio.klaviyo", "composio.shopify", "composio.hubspot", "composio.salesforce",
    ]);
  });
  it("filters by category and search", () => {
    expect(filterConnectors("All", "").length).toBe(29);
    expect(filterConnectors("Ads", "").map((c) => c.slug)).toEqual(["meta_ads", "google_ads", "linkedin_ads", "x_ads", "reddit_ads", "tiktok_ads", "microsoft_ads", "pinterest_ads", "snapchat_ads", "spotify_ads"]);
    expect(filterConnectors("All", "stripe").map((c) => c.slug)).toEqual(["stripe"]);
  });
  it("connected uses the shared row finder (Instagram via Composio counts)", () => {
    expect(isConnected([{ slug: "composio.instagram" }], "instagram_social")).toBe(true);
    expect(isConnected([], "stripe")).toBe(false);
  });
  it("counts an app connected through catalog search (a composio.* row), named from the catalog", () => {
    expect(connectedNames([{ slug: "composio.notion" }], [{ slug: "notion", name: "Notion" }])).toEqual(["Notion"]);
    expect(connectedNames([{ slug: "composio.airtable" }], [])).toEqual(["airtable"]);
  });
  it("ignores legacy pipedream.* rows and hidden composio twins of native apps (spec 4, 14)", () => {
    expect(connectedNames([{ slug: "pipedream.notion" }, { slug: "composio.linear" }], [{ slug: "notion", name: "Notion" }])).toEqual([]);
  });
  it("a Google Analytics or Search Console sign-in with no picked property or site is not counted", () => {
    const catalog = [{ slug: "google_analytics", name: "Google Analytics" }, { slug: "google_search_console", name: "Google Search Console" }];
    expect(connectedNames([{ slug: "composio.google_analytics" }, { slug: "composio.google_search_console" }], catalog)).toEqual([]);
    expect(connectedNames([{ slug: "composio.google_analytics" }, { slug: "google_analytics" }], catalog)).toEqual(["Google Analytics"]);
    expect(connectedNames([{ slug: "composio.tiktok_ads" }], [])).toEqual(["TikTok Ads"]);
  });
  it("ad tiles promise reading spend and results, never running ads", () => {
    const ads = TOP_CONNECTORS.filter((c) => c.category === "Ads");
    expect(ads.filter((c) => !/^Reads your .+ spend and results$/.test(c.what))).toEqual([]);
  });
  it("the Zavi-managed GitHub row is not the founder's connector (no count, Continue stays off)", () => {
    expect(isConnected([{ slug: "github", account_login: "Praxis-build" }], "github")).toBe(false);
    expect(connectedNames([{ slug: "github", account_login: "Praxis-build" }], [])).toEqual([]);
    expect(connectedNames([{ slug: "github", account_login: "acme" }], [])).toEqual(["GitHub"]);
  });
});
