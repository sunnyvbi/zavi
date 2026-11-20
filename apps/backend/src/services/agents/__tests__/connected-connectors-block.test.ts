import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/agents/deepagent/engine", () => ({}));
const failures = vi.hoisted(() => ({ reconnect: new Map<string, { since: string; kind: "auth" | "account_gone" }>(), slow: new Map<string, string>() }));
vi.mock("@/services/connectors/ad-read-failures", () => ({ readAdReadFailures: async () => failures }));

import { buildConnectedConnectorsBlock, loadStoppedConnectorLogins } from "../generic-dispatcher";

describe("buildConnectedConnectorsBlock", () => {
  it("renders the roster + the never-guess rule + connectors__search offer", () => {
    const block = buildConnectedConnectorsBlock([
      "composio.notion",
      "slack",
      "github",
    ]);
    expect(block).toContain("Notion (via Composio)");
    expect(block).toContain("Slack");
    expect(block).toContain("GitHub");
    expect(block).toContain("CONNECTED CONNECTORS for this tenant:");
    expect(block).toContain("CONFIGURED roster");
    expect(block).toContain("RUN CAPABILITIES");
    expect(block).not.toContain("ONLY authority on connector state");
    expect(block).toContain("NEVER assert from memory");
    expect(block).toContain("connectors__search");
  });

  it("renders composio aggregator slugs with a '(via Composio)' annotation", () => {
    const block = buildConnectedConnectorsBlock(["composio.instagram"]);
    expect(block).toContain("Instagram (via Composio)");
  });

  it("is byte-stable: de-dupes + sorts slugs deterministically", () => {
    const a = buildConnectedConnectorsBlock(["slack", "composio.notion", "slack"]);
    const b = buildConnectedConnectorsBlock(["composio.notion", "slack"]);
    expect(a).toBe(b);
  });

  it("returns empty string when the tenant has no connectors", () => {
    expect(buildConnectedConnectorsBlock([])).toBe("");
    expect(buildConnectedConnectorsBlock(["", ""])).toBe("");
  });

  it("drops pipedream.* and native-rail composio.* slugs; keeps Composio-rail apps and natives", () => {
    const block = buildConnectedConnectorsBlock([
      "pipedream.gmail",
      "composio.notion",
      "composio.linear",
      "linear",
    ]);
    expect(block).toContain("Notion (via Composio)");
    expect(block).not.toContain("Pipedream");
    expect(block).not.toContain("Gmail");
    expect(block).not.toContain("Linear (via Composio)");
    expect(block.match(/Linear/g)).toHaveLength(1);
  });

  it("is empty when every slug is unreachable", () => {
    expect(buildConnectedConnectorsBlock(["pipedream.posthog", "composio.stripe"])).toBe("");
  });

  describe("half-connected Google (GA, Search Console)", () => {
    const roster = (b: string) => b.split("\n")[0];

    it("a sign-in with nothing picked says so, never 'connected'", () => {
      const block = roster(buildConnectedConnectorsBlock(["composio.google_analytics", "composio.google_search_console", "slack"]));
      expect(block).toContain(
        "Google Analytics: Google sign-in done, but no property is set up for this workspace yet (connect again in Settings)",
      );
      expect(block).toContain(
        "Google Search Console: Google sign-in done, but no site is set up for this workspace yet (connect again in Settings)",
      );
      expect(block).not.toContain("Google Analytics (via Composio)");
      expect(block).toContain("Slack");
    });

    it("sign-in plus a picked property is ONE connected entry", () => {
      const block = roster(buildConnectedConnectorsBlock(["google_analytics", "composio.google_analytics"]));
      expect(block.match(/Google Analytics/g)).toHaveLength(1);
      expect(block).not.toContain("no property");
      expect(block).not.toContain("via Composio");
    });

    it("a native row alone is unchanged", () => {
      expect(buildConnectedConnectorsBlock(["google_search_console"])).toBe(buildConnectedConnectorsBlock(["google_search_console", "google_search_console"]));
      expect(roster(buildConnectedConnectorsBlock(["google_search_console"]))).toBe("CONNECTED CONNECTORS for this tenant: Google Search Console.");
    });
  });

  describe("a set-up connector whose login stopped working", () => {
    it("says so with the date, for the Composio and the native entry, and leaves the others alone", () => {
      const stopped = new Map([["composio.reddit_ads", "2026-10-15T15:07:17Z"], ["meta_ads", "2026-10-14T02:00:00Z"]]);
      const line = buildConnectedConnectorsBlock(["composio.reddit_ads", "meta_ads", "slack"], stopped).split("\n")[0];
      expect(line).toContain("Reddit Ads (via Composio): login stopped working Oct 15; reconnect it");
      expect(line).toContain("Meta Ads: login stopped working Oct 14; reconnect it");
      expect(line).toContain("Slack");
      expect(line).not.toContain("Slack:");
    });
    it("no note for a stopped slug the tenant has no row for, or an unreadable date", () => {
      const block = buildConnectedConnectorsBlock(["slack"], new Map([["composio.reddit_ads", "2026-10-15T15:07:17Z"], ["slack", "not a date"]]));
      expect(block).toBe(buildConnectedConnectorsBlock(["slack"]));
    });
    it("loadStoppedConnectorLogins keeps only login failures (auth), not a missing ad account", async () => {
      failures.reconnect = new Map([
        ["composio.reddit_ads", { since: "2026-10-15T15:07:17Z", kind: "auth" }],
        ["meta_ads", { since: "2026-10-15T01:00:00Z", kind: "account_gone" }],
      ]);
      expect(await loadStoppedConnectorLogins("T1")).toEqual(new Map([["composio.reddit_ads", "2026-10-15T15:07:17Z"]]));
      expect(await loadStoppedConnectorLogins("")).toEqual(new Map());
    });
  });
});
