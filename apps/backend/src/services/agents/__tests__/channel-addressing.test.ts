
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  channelAgentSlugs,
  channelForAgent,
  isChannelAgent,
  renderChannelRosterForPrompt,
} from "../channel-agents";
import { parseChannelMention } from "../mention";

describe("channelForAgent maps each executor to its own channel", () => {
  it("resolves seo to seo and geo to geo (they shared one agent until 2026-09-16)", () => {
    expect(channelForAgent("seo")?.channel_slug).toBe("seo");
    expect(channelForAgent("geo")?.channel_slug).toBe("geo");
  });
});

describe("channel_only never refuses a run", () => {
  it("is documented as a listing decision in the schema", () => {
    const schema = readFileSync(
      join(process.cwd(), "src/services/agents/types.ts"),
      "utf8",
    );
    expect(schema).toContain("LISTING-ONLY hide for per-channel agents");
    expect(schema).toContain("It is not a kill switch");
  });
});

describe("channelAgents roster", () => {
  it("derives every channel executor from the shared registry", () => {
    const slugs = channelAgentSlugs();
    expect(slugs.size).toBeGreaterThanOrEqual(17);
    expect(slugs.has("meta_ads")).toBe(true);
    expect(slugs.has("seo")).toBe(true);
    expect(slugs.has("email_marketing")).toBe(true);
  });

  it("does NOT admit the retired generalists", () => {
    for (const retired of ["performance-marketer", "seo-geo", "growth-lead"]) {
      expect(isChannelAgent(retired)).toBe(false);
    }
  });

  it("maps an agent slug back to its channel identity", () => {
    const meta = channelForAgent("meta_ads");
    expect(meta?.channel_slug).toBe("meta_ads");
    expect(meta?.name).toBe("Meta Ads");
    expect(meta?.category).toBe("paid");
  });

  it("renders a grouped roster naming every channel exactly once", () => {
    const rendered = renderChannelRosterForPrompt();
    for (const slug of channelAgentSlugs()) {
      const hits = rendered.split(`\`${slug}\``).length - 1;
      expect(hits, `${slug} should appear once`).toBe(1);
    }
  });
});

describe("parseChannelMention", () => {
  it("resolves a leading channel address", () => {
    const m = parseChannelMention("@meta_ads why is CPA up this week?");
    expect(m?.target.agent_slug).toBe("meta_ads");
    expect(m?.intent).toBe("why is CPA up this week?");
  });

  it("accepts punctuation and casing after the name", () => {
    expect(parseChannelMention("@SEO: audit our pricing page")?.intent).toBe(
      "audit our pricing page",
    );
  });

  it("ignores a mention that is not a channel", () => {
    expect(parseChannelMention("@engineer fix the login bug")).toBeNull();
    expect(parseChannelMention("@nobody hello")).toBeNull();
  });

  it("ignores a mid-sentence mention", () => {
    expect(parseChannelMention("compare @meta_ads to google")).toBeNull();
  });

  it("ignores a bare address with no ask", () => {
    expect(parseChannelMention("@meta_ads")).toBeNull();
    expect(parseChannelMention("@meta_ads   ")).toBeNull();
  });

  it("ignores an empty message", () => {
    expect(parseChannelMention("")).toBeNull();
  });
});
