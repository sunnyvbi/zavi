import { describe, it, expect } from "vitest";
import { SOCIAL_LIMITS } from "@zavi/shared";
import {
  SOCIAL_CHANNEL_CONNECTOR,
  SOCIAL_SLUGS,
  socialAccountName,
  socialPlatformLabel,
} from "./socialConnectorRows";

describe("socialConnectorRows", () => {
  it("every shared channel maps to one of the five social connector slugs", () => {
    for (const ch of Object.keys(SOCIAL_LIMITS)) {
      const slug = (SOCIAL_CHANNEL_CONNECTOR as Record<string, string>)[ch];
      expect(SOCIAL_SLUGS as readonly string[]).toContain(slug);
    }
  });

  it("reads team_name verbatim (each vendor already stores its own format)", () => {
    const rows = [
      { slug: "linkedin_social", team_name: "Ravi Kumar" },
      { slug: "x_social", team_name: "@zavi" },
      { slug: "reddit_social", team_name: "u/zavi" },
    ];
    expect(socialAccountName("linkedin_image", rows)).toEqual({ connected: true, name: "Ravi Kumar" });
    expect(socialAccountName("x", rows)).toEqual({ connected: true, name: "@zavi" });
    expect(socialAccountName("reddit", rows)).toEqual({ connected: true, name: "u/zavi" });
  });

  it("the Composio row lights Instagram / YouTube; a Pipedream row does not", () => {
    expect(socialAccountName("instagram_image", [{ slug: "composio.instagram", team_name: null }]).connected).toBe(true);
    expect(socialAccountName("youtube_video", [{ slug: "composio.youtube", team_name: null }]).connected).toBe(true);
    expect(socialAccountName("instagram_image", [{ slug: "pipedream.instagram_business", team_name: null }]).connected).toBe(false);
  });

  it("a leftover native youtube_social row does not light YouTube", () => {
    expect(socialAccountName("youtube_video", [{ slug: "youtube_social", team_name: "Chan" }]).connected).toBe(false);
  });

  it("does not promise the preferred rail's name when a different native backup may be used", () => {
    expect(socialAccountName("instagram_image", [
      { slug: "instagram_social", team_name: "@native" },
      { slug: "composio.instagram", team_name: "@composio" },
    ])).toEqual({ connected: true, name: null });
  });

  it("no row → not connected; row without a name → connected, nameless", () => {
    expect(socialAccountName("youtube_video", [])).toEqual({ connected: false, name: null });
    expect(socialAccountName("youtube_video", [{ slug: "composio.youtube", team_name: null }])).toEqual({
      connected: true,
      name: null,
    });
  });

  it("labels are human, and an unknown channel degrades to its slug words", () => {
    expect(socialPlatformLabel("linkedin_image")).toBe("LinkedIn");
    expect(socialPlatformLabel("youtube_video")).toBe("YouTube");
    expect(socialPlatformLabel("tiktok_video")).toBe("TikTok");
    expect(socialPlatformLabel("carrier_pigeon_scroll")).toBe("carrier pigeon scroll");
  });
});
