import { describe, expect, it } from "vitest";
import { connectAppChoices } from "./connectAppsModel";

const titles = (g: { title: string; apps: { slug: string }[]; more: { slug: string }[] }[] | null) => (g ?? []).map((x) => [x.title, x.apps.map((a) => a.slug), x.more.map((a) => a.slug)]);

describe("connectAppChoices: the grouped list (Ravi, 2026-10-24)", () => {
  it("shows 15 apps up front and the rest behind See more by app type before any search", () => {
    const { groups, apps } = connectAppChoices("", [], [], 50);
    expect(titles(groups)).toEqual([
      ["Messaging", ["slack", "whatsapp"], ["teams", "telegram", "imessage", "discord"]],
      ["Analytics", ["google_analytics", "google_search_console"], ["posthog"]],
      ["Ads", ["meta_ads", "google_ads", "linkedin_ads"], ["x_ads", "reddit_ads", "tiktok_ads", "microsoft_ads", "pinterest_ads", "snapchat_ads", "spotify_ads"]],
      ["Social", ["instagram_social", "composio.youtube", "x_social", "linkedin_social"], ["tiktok"]],
      ["Revenue", ["stripe", "composio.hubspot"], ["composio.mailchimp", "composio.klaviyo", "email", "composio.salesforce", "composio.shopify"]],
      ["Product & data", ["github", "operator_db"], ["supabase"]],
    ]);
    expect(apps).toHaveLength(34);
  });
  it("moves a connected See-more app up front, and puts one outside every group under Also connected", () => {
    const { groups } = connectAppChoices("", [{ slug: "tiktok" }, { slug: "jira" }] as never, [], 50);
    expect(titles(groups).find((g) => g[0] === "Social")).toEqual(["Social", ["instagram_social", "composio.youtube", "x_social", "linkedin_social", "tiktok"], []]);
  });
  it("is one flat list while searching", () => {
    const { groups, apps } = connectAppChoices("tik", [], [], 50);
    expect(groups).toBeNull();
    expect(apps.map((a) => a.slug)).toContain("tiktok");
  });
});

describe("connectAppChoices: an app with its own tile", () => {
  const catalog = [{ slug: "google_analytics", name: "Google Analytics" }, { slug: "notion", name: "Notion" }] as never;
  it("does not list a Google Analytics sign-in with no picked property as a connected catalog app", () => {
    const { apps, groups } = connectAppChoices("", [{ slug: "composio.google_analytics" }, { slug: "composio.notion" }] as never, catalog, 50);
    expect(apps.map((a) => a.slug)).not.toContain("composio.google_analytics");
    expect(titles(groups).find((g) => g[0] === "Also connected")).toEqual(["Also connected", ["composio.notion"], []]);
  });
  it("shows the tile once in a search, not a second catalog row for the same app", () => {
    const { apps } = connectAppChoices("google analytics", [], catalog, 50);
    expect(apps.map((a) => a.slug)).toEqual(["google_analytics"]);
  });
});

describe("connectAppChoices: logos", () => {
  it("gives a fixed tile the catalog's logo for the same app", () => {
    const catalog = [{ slug: "salesforce", name: "Salesforce", logo: "https://logos.example/sf.png" }, { slug: "snapchat", name: "Snapchat", logo: "https://logos.example/snap.png" }] as never;
    const { apps } = connectAppChoices("", [], catalog, 50);
    expect(apps.find((a) => a.slug === "composio.salesforce")?.logo).toBe("https://logos.example/sf.png");
    expect(apps.find((a) => a.slug === "snapchat_ads")?.logo).toBe("https://logos.example/snap.png");
  });
});
