// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { matchAgentMention, matchChannelMention } from "@zavi/shared";
import {
  CGO_TARGET,
  channelGroup,
  channelOnlySections,
  connectSlugFor,
  flattenSections,
  homeMentionSections,
  matchHomeAgentMention,
  readRecentMentions,
  recentStorageKey,
  rememberRecentMention,
  teamFromTree,
  type TeamMember,
} from "./mentionTargets";

const TEAM: TeamMember[] = [
  { slug: "engineer", name: "Engineer", lockedTier: "pro" },
  { slug: "fundraising", name: "Fundraising", lockedTier: null },
  { slug: "c-abcd1234", name: "Catering quotes", lockedTier: null, custom: true },
];

const ids = (s: { id: string }[]) => s.map((x) => x.id);

describe("homeMentionSections", () => {
  const base = { query: "", connected: new Set(["tiktok_ads"]), team: TEAM, recent: [] as string[] };

  it("opens with Your CGO, then connected, team, and the grouped rest", () => {
    const s = homeMentionSections(base);
    expect(s[0].rows).toEqual([CGO_TARGET]);
    expect(ids(s).slice(0, 3)).toEqual(["cgo", "connected", "team"]);
    expect(ids(s).slice(3)).toEqual(["off-ads", "off-search", "off-social", "off-creators", "off-messages"]);
    expect(s[3].heading).toBe("Not connected yet");
    expect(s[4].heading).toBeUndefined();
  });

  it("puts the connected channels under Connected and not again below", () => {
    const s = homeMentionSections(base);
    const connected = s.find((x) => x.id === "connected")!.rows.map((r) => r.sendSlug);
    expect(connected).toEqual(["tiktok_ads"]);
    const off = flattenSections(s.filter((x) => x.id.startsWith("off-"))).map((r) => r.sendSlug);
    expect(off).not.toContain("tiktok_ads");
    expect(off).toContain("google_ads");
  });

  it("lists plan-locked team members last", () => {
    const team = homeMentionSections(base).find((x) => x.id === "team")!.rows.map((r) => r.sendSlug);
    expect(team).toEqual(["fundraising", "c-abcd1234", "engineer"]);
  });

  it("shows up to three Recent picks still on the roster, newest first, not repeated below", () => {
    const s = homeMentionSections({
      ...base,
      recent: ["agent:engineer", "agent:c-gone00000", "agent:cgo", "channel:tiktok_ads", "channel:seo", "channel:sms"],
    });
    const recent = s.find((x) => x.id === "recent")!.rows.map((r) => r.key);
    expect(recent).toEqual(["agent:engineer", "channel:tiktok_ads", "channel:seo"]);
    expect(s.find((x) => x.id === "connected")).toBeUndefined();
    const keys = flattenSections(s).map((r) => r.key);
    expect(keys.filter((k) => k === "agent:engineer")).toHaveLength(1);
    expect(keys.filter((k) => k === "agent:cgo")).toHaveLength(1);
  });

  it("hides Recent when nothing was picked", () => {
    expect(ids(homeMentionSections(base))).not.toContain("recent");
  });

  it("filters every section by what follows the @", () => {
    expect(flattenSections(homeMentionSections({ ...base, query: "cgo" })).map((r) => r.key)).toEqual(["agent:cgo"]);
    expect(flattenSections(homeMentionSections({ ...base, query: "cater" })).map((r) => r.key)).toEqual([
      "agent:c-abcd1234",
    ]);
    const meta = flattenSections(homeMentionSections({ ...base, query: "meta" })).map((r) => r.key);
    expect(meta).toContain("channel:meta_ads");
    expect(meta).not.toContain("agent:cgo");
  });

  it("claims nothing is connected while the connections are still loading", () => {
    const s = homeMentionSections({ ...base, connected: null });
    expect(ids(s)).not.toContain("connected");
    expect(flattenSections(s).some((r) => r.sendSlug === "meta_ads")).toBe(true);
  });

  it("never lists a retired channel", () => {
    expect(flattenSections(homeMentionSections(base)).map((r) => r.key)).not.toContain("channel:blog");
  });
});

describe("what a pick sends", () => {
  it("every built-in target's send text resolves through the shared matchers", () => {
    const rows = flattenSections(homeMentionSections({ query: "", connected: new Set(), team: TEAM, recent: [] }));
    for (const r of rows) {
      const text = `@${r.sendSlug} what next?`;
      if (r.kind === "channel") expect(matchChannelMention(text)?.agent_slug).toBe(r.sendSlug);
      else if (!("custom" in r && r.custom)) expect(matchAgentMention(text)?.agent_slug).toBe(r.sendSlug);
      else expect(matchHomeAgentMention(text, [{ slug: r.sendSlug, name: r.name }])?.agent_slug).toBe(r.sendSlug);
    }
  });
});

describe("channelGroup", () => {
  it("files channels under the five Home groups", () => {
    expect(channelGroup({ slug: "meta_ads", category: "paid" })).toBe("ads");
    expect(channelGroup({ slug: "ugc", category: "organic", section: "creators" })).toBe("creators");
    expect(channelGroup({ slug: "seo", category: "organic" })).toBe("search");
    expect(channelGroup({ slug: "instagram_organic", category: "organic" })).toBe("social");
    expect(channelGroup({ slug: "email_marketing", category: "owned" })).toBe("messages");
  });
});

describe("connectSlugFor", () => {
  it("offers Connect only for a connector with a real connect path", () => {
    expect(connectSlugFor({ connectors: ["meta_ads"] })).toBe("meta_ads");
    expect(connectSlugFor({ connectors: [] })).toBeNull();
  });
});

describe("channelOnlySections", () => {
  it("is today's single Channels list everywhere but Home", () => {
    const s = channelOnlySections("");
    expect(ids(s)).toEqual(["channels"]);
    expect(s[0].rows.every((r) => r.kind === "channel")).toBe(true);
  });
});

describe("teamFromTree", () => {
  it("lists only agents the sidebar shows, with their lock, then custom agents", () => {
    const team = teamFromTree(
      [
        { slug: "engineer", locked_tier: "pro" },
        { slug: "supply-demand-balancer" },
        { slug: "c-abcd1234", name: "Catering quotes", custom: true },
        { slug: "support-lead" },
      ],
      false,
    );
    expect(team).toEqual([
      { slug: "engineer", name: "Engineer", lockedTier: "pro" },
      { slug: "c-abcd1234", name: "Catering quotes", lockedTier: null, custom: true },
    ]);
  });
});

describe("matchHomeAgentMention", () => {
  const custom = [{ slug: "c-abcd1234", name: "Catering quotes" }];
  it("resolves built-ins and this workspace's custom agents only", () => {
    expect(matchHomeAgentMention("@your cgo what is holding growth back?", custom)?.agent_slug).toBe("cgo");
    expect(matchHomeAgentMention("@c-abcd1234 quote 40 people", custom)?.name).toBe("Catering quotes");
    expect(matchHomeAgentMention("@c-zzzz9999 quote", custom)).toBeNull();
    expect(matchHomeAgentMention("@support-lead help", custom)).toBeNull();
    expect(matchHomeAgentMention("what about @cgo", custom)).toBeNull();
  });
});

describe("Recent storage", () => {
  afterEach(() => window.localStorage.clear());

  it("is keyed per person and workspace, and needs both", () => {
    expect(recentStorageKey("u1", "t1")).toBe("zavi:mention-recent:u1:t1");
    expect(recentStorageKey("u1", null)).toBeNull();
    expect(readRecentMentions(null)).toEqual([]);
  });

  it("keeps the newest pick first without duplicates", () => {
    const k = recentStorageKey("u1", "t1");
    rememberRecentMention(k, "channel:meta_ads");
    rememberRecentMention(k, "agent:cgo");
    rememberRecentMention(k, "channel:meta_ads");
    expect(readRecentMentions(k)).toEqual(["channel:meta_ads", "agent:cgo"]);
    expect(readRecentMentions(recentStorageKey("u2", "t1"))).toEqual([]);
  });

  it("survives junk and a throwing store", () => {
    const k = recentStorageKey("u1", "t1");
    window.localStorage.setItem(k!, "{not json");
    expect(readRecentMentions(k)).toEqual([]);
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(() => rememberRecentMention(k, "agent:cgo")).not.toThrow();
    } finally {
      Storage.prototype.setItem = orig;
    }
  });
});
