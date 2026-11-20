import { describe, it, expect } from "vitest";
import { CONNECTOR_DESCRIPTORS, CONNECTOR_CONNECT } from "@zavi/shared";
import { AD_ROW_SLUGS, adConnectorRows } from "./adConnectorRows";
import { CHAT_SLUGS } from "./chatConnectorRows";
import { NATIVE_TILE_OWNED } from "./ConnectedApps";

const BESPOKE_TILE_SLUGS = [
  "github",
  "meta_ads",
  "google_ads",
  "google_analytics",
  "google_search_console",
  "operator_db",
  "jira",
  "stripe",
  "linear",
  "intercom",
  "posthog",
  "higgsfield",
  "sentry",
  "figma",
  "supabase",
  "google_calendar",
  "google_sheets",
  "linkedin_social",
  "x_social",
  "reddit_social",
  "instagram_social",
  "tiktok",
  "email",
] as const;

describe("Settings tile parity with the shared connector descriptor", () => {
  const claimed = CONNECTOR_DESCRIPTORS.filter(
    (d) => d.settingsTile && !d.slug.startsWith("composio."),
  ).map((d) => d.slug);
  const rendered = new Set<string>([
    ...BESPOKE_TILE_SLUGS,
    ...AD_ROW_SLUGS.map((r) => r.slug),
    ...CHAT_SLUGS,
  ]);

  it("every settingsTile:true slug has a rendered row source", () => {
    const missing = claimed.filter((slug) => !rendered.has(slug));
    expect(missing, `settingsTile:true but no Settings row renders it: ${missing.join(", ")}`).toEqual([]);
  });

  it("every ad tile builds a row even with nothing connected (tile shows as Not connected, never vanishes)", () => {
    const rows = adConnectorRows([]);
    expect(rows.map((r) => r.slug)).toEqual(AD_ROW_SLUGS.map((r) => r.slug));
    expect(rows.every((r) => r.connected === false)).toBe(true);
  });

  it("every rail row a native tile owns is aliased by a tile source (fold and alias stay in sync)", () => {
    const adSources = new Set(AD_ROW_SLUGS.flatMap((r) => [...r.sources]));
    const ga = new Set(["composio.google_analytics", "composio.google_search_console"]);
    const unaliased = [...NATIVE_TILE_OWNED].filter((s) => !ga.has(s) && !adSources.has(s));
    expect(unaliased, `NATIVE_TILE_OWNED row no tile aliases: ${unaliased.join(", ")}`).toEqual([]);
  });

  it("a Composio-rail connection lights the native ad tile", () => {
    const rows = adConnectorRows([
      { slug: "composio.tiktok_ads", team_name: "Upcar", connected_at: "2026-10-01T00:00:00Z" },
    ]);
    const tiktok = rows.find((r) => r.slug === "tiktok_ads");
    expect(tiktok?.connected).toBe(true);
    expect(tiktok?.team_name).toBe("Upcar");
  });

  it("every descriptor-claimed tile slug has a connect contract entry (deep links + chat cards resolve)", () => {
    const missing = claimed.filter((slug) => !(slug in CONNECTOR_CONNECT));
    expect(missing, `descriptor tile without CONNECTOR_CONNECT entry: ${missing.join(", ")}`).toEqual([]);
  });
});
