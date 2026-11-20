
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { actionsStoreFor,
  ACTION_TYPES,
  CHANNELS,
  allowedActionTypes,
  coerceActionType,
  type Channel,
} from "@zavi/shared";
import { listRecipeSlugs, loadChannelRecipe, renderChannelLifecycleBlock } from "../recipe";
import { actionTypeFromStep, deriveActionType } from "../action-type";

const CHANNELS_ROOT = path.join(process.cwd(), "src", "channels");
const MIGRATION = path.join(
  process.cwd(),
  "..",
  "..",
  "supabase",
  "migrations",
  "20260919035832_channel_actions.sql",
);

const THE_13 = [
  "text_post",
  "image_post",
  "video_post",
  "reply",
  "send_message",
  "create_ad",
  "update_ad",
  "pause_ad",
  "fix",
  "check",
  "setup",
  "page",
  "other",
];

describe("#1 ACTION_TYPES", () => {
  it("is exactly the 13, in order", () => {
    expect([...ACTION_TYPES]).toEqual(THE_13);
  });

  it("matches the channel_actions action_type CHECK constraint", () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    const m = sql.match(/action_type\s+text not null check \(action_type in \(([\s\S]*?)\)\)/);
    expect(m, "action_type CHECK not found in the migration").not.toBeNull();
    const inSql = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(inSql).toEqual(THE_13);
  });
});

describe("allowed action types per channel (locked 2026-09-18)", () => {
  const ADS = ["create_ad", "update_ad", "pause_ad", "fix", "check", "setup", "page", "text_post", "image_post", "video_post"];
  const ORGANIC = ["text_post", "image_post", "video_post", "reply", "fix", "check", "setup"];
  const EXPECTED: Record<string, string[]> = {
    meta_ads: ADS,
    google_ads: ADS,
    tiktok_ads: ADS,
    linkedin_ads: ADS,
    reddit_ads: ADS,
    x_ads: ADS,
    youtube_ads: ADS,
    chatgpt_ads: ADS,
    x_organic: ORGANIC,
    linkedin_organic: ORGANIC,
    instagram_organic: ORGANIC,
    tiktok_organic: ORGANIC,
    youtube_organic: ORGANIC,
    reddit_organic: ORGANIC,
    pinterest_organic: ORGANIC,
    seo: ["fix", "text_post", "check", "page"],
    geo: ["fix", "text_post", "check", "page"],
    blog: ["text_post", "check", "fix", "setup"],
    email_marketing: ["send_message", "fix", "check"],
    sms: ["send_message", "fix", "check", "setup"],
    ugc: ["video_post", "send_message", "fix", "check"],
    generated_video: ["video_post", "check"],
  };

  it("every registry channel has exactly its locked list", () => {
    const slugs = (CHANNELS as readonly Channel[]).map((c) => c.slug).sort();
    expect(slugs).toEqual(Object.keys(EXPECTED).sort());
    for (const c of CHANNELS as readonly Channel[]) {
      expect([...(c.action_types ?? [])], c.slug).toEqual(EXPECTED[c.slug]);
    }
  });

  it("`other` is always allowed, last, and never listed per channel", () => {
    for (const c of CHANNELS as readonly Channel[]) {
      expect(c.action_types as readonly string[]).not.toContain("other");
      const allowed = allowedActionTypes(c.slug);
      expect(allowed[allowed.length - 1]).toBe("other");
    }
    expect(allowedActionTypes("not_a_channel")).toEqual([]);
  });

  it("only a channel with an archive statement is switched", () => {
    const switched = (CHANNELS as readonly Channel[])
      .filter((c) => c.actions_store === "channel_actions")
      .map((c) => c.slug);
    expect(switched.length).toBeGreaterThan(0);
    expect(actionsStoreFor("meta_ads")).toBe("channel_actions");
    expect(actionsStoreFor("youtube_ads")).toBe("channel_actions");
    expect(switched).toContain("youtube_ads");
  });

  it("coerces an unknown or disallowed type to `other`, and counts it", () => {
    expect(coerceActionType("seo", "fix")).toEqual({ action_type: "fix", coerced: false });
    expect(coerceActionType("seo", "create_ad")).toEqual({ action_type: "other", coerced: true });
    expect(coerceActionType("seo", "tweet")).toEqual({ action_type: "other", coerced: true });
    expect(coerceActionType("seo", undefined)).toEqual({ action_type: "other", coerced: true });
    expect(coerceActionType("seo", "other")).toEqual({ action_type: "other", coerced: false });
  });
});

describe("#10 recipe lint: allowed types come from the registry", () => {
  it("no recipe carries an Action types block: switching a channel costs zero prompt bytes", () => {
    for (const slug of listRecipeSlugs()) {
      const body = loadChannelRecipe(slug).body;
      expect(body.includes("## Action types"), `${slug}: asks for a stripped field`).toBe(false);
    }
  });

  const SWITCHED = (CHANNELS as readonly Channel[])
    .filter((c) => c.actions_store === "channel_actions")
    .map((c) => c.slug);
  const UNSWITCHED = (CHANNELS as readonly Channel[])
    .filter((c) => c.actions_store !== "channel_actions")
    .map((c) => c.slug);

  it("a switched channel is told to read history, set repeat_of, report metrics and flag stale", () => {
    expect(SWITCHED.length).toBeGreaterThan(0);
    for (const slug of SWITCHED) {
      const body = loadChannelRecipe(slug).body;
      expect(body, `${slug}: no history block`).toContain("## Your channel's history");
      expect(body, `${slug}: history`).toContain("`channel_history`");
      expect(body, `${slug}: repeat_of`).toContain("`repeat_of`");
      expect(body, `${slug}: metrics`).toContain("`metrics[]`");
      expect(body, `${slug}: stale`).toContain("`stale[]`");
      expect(body.includes("## Action types"), `${slug}`).toBe(false);
    }
  });

  it("an unswitched channel's body is byte-identical to base + delta, with no block", () => {
    const base = matter(fs.readFileSync(path.join(CHANNELS_ROOT, "_base", "recipe-base.md"), "utf8"));
    for (const slug of UNSWITCHED) {
      if (!listRecipeSlugs().includes(slug)) continue;
      const delta = matter(fs.readFileSync(path.join(CHANNELS_ROOT, slug, "recipe.md"), "utf8"));
      const expected = `${base.content.trim()}\n\n---\n\n${delta.content.trim()}\n`;
      expect(loadChannelRecipe(slug).body, `${slug}`).toBe(expected);
      expect(renderChannelLifecycleBlock(slug)).toBe("");
    }
  });

  it("renders nothing for a slug the registry does not know", () => {
    expect(renderChannelLifecycleBlock("not_a_channel")).toBe("");
  });

  it("no recipe file hand-writes a list of action types", () => {
    const offenders: string[] = [];
    const files = [
      path.join(CHANNELS_ROOT, "_base", "recipe-base.md"),
      ...listRecipeSlugs().map((s) => path.join(CHANNELS_ROOT, s, "recipe.md")),
    ];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const line of text.split("\n")) {
        const hits = THE_13.filter((t) => t !== "other" && new RegExp(`\\b${t}\\b`).test(line));
        if (hits.length >= 3) offenders.push(`${path.relative(CHANNELS_ROOT, f)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("action_type derived in code", () => {
  const STEPS: Array<{ shape: string; title: string; kind: string | null; staged?: string | null }> = [
    { shape: "local-services", title: "Post the before/after from this week's job", kind: "post" },
    { shape: "local-services", title: "Reply to the neighbourhood thread asking for a quote", kind: "comment" },
    { shape: "b2b-software", title: "Publish the integration teardown as a thread", kind: "thread" },
    { shape: "b2b-software", title: "Rewrite the pricing page headline", kind: "page_copy" },
    { shape: "b2b-software", title: "Check which signup step is dropping people", kind: null },
    { shape: "goods-shop", title: "Post the unboxing clip", kind: "post", staged: "x_video" },
    { shape: "goods-shop", title: "Post the product shot with the new caption", kind: "post", staged: "x_image" },
    { shape: "marketplace", title: "Connect the ads account so spend can be read", kind: null },
    { shape: "marketplace", title: "Draft the three supply-side outreach emails", kind: "email" },
    { shape: "media", title: "Write the short-form script for the explainer", kind: "script" },
    { shape: "media", title: "List the ten threads worth answering", kind: "list" },
    { shape: "prof-services", title: "Decide the handle and pin the introduction post", kind: null },
    { shape: "prof-services", title: "Send the follow-up to last month's enquiries", kind: "dm" },
  ];

  it("every derived type is one the registry allows for that channel", () => {
    for (const c of CHANNELS as readonly Channel[]) {
      const allowed = allowedActionTypes(c.slug);
      for (const s of STEPS) {
        const { action_type } = deriveActionType(
          c.slug,
          { title: s.title, deliverable: s.kind ? { kind: s.kind } : null },
          s.staged ?? null,
        );
        expect(allowed, `${c.slug} / ${s.shape} / ${s.title}`).toContain(action_type);
      }
    }
  });

  it("maps each deliverable kind the way the measurement says", () => {
    expect(actionTypeFromStep("post", "Post it", null)).toBe("text_post");
    expect(actionTypeFromStep("thread", "Post it", null)).toBe("text_post");
    expect(actionTypeFromStep("post", "Post it", "x_image")).toBe("image_post");
    expect(actionTypeFromStep("post", "Post it", "x_video")).toBe("video_post");
    expect(actionTypeFromStep("comment", "Answer them", null)).toBe("reply");
    expect(actionTypeFromStep("page_copy", "Rewrite the hero", null)).toBe("fix");
    expect(actionTypeFromStep("list", "Ten threads", null)).toBe("other");
    expect(actionTypeFromStep("not_a_kind", "Something else", null)).toBe("check");
  });

  it("a step with no deliverable is setup when it connects something, else check", () => {
    expect(actionTypeFromStep(null, "Connect the ads account", null)).toBe("setup");
    expect(actionTypeFromStep(null, "Claim the profile", null)).toBe("setup");
    expect(actionTypeFromStep(null, "Decide the handle", null)).toBe("setup");
    expect(actionTypeFromStep(null, "Pin the introduction post", null)).toBe("setup");
    expect(actionTypeFromStep(null, "Register the account", null)).toBe("setup");
    expect(actionTypeFromStep(null, "Check why conversions stopped", null)).toBe("check");
    expect(actionTypeFromStep(null, "Measure the landing page", null)).toBe("check");
  });

  it("a type the channel does not allow is coerced to other and counted", () => {
    expect(deriveActionType("google_ads", { title: "x", deliverable: { kind: "comment" } })).toEqual({
      action_type: "other",
      coerced: true,
    });
    expect(deriveActionType("x_organic", { title: "x", deliverable: { kind: "comment" } })).toEqual({
      action_type: "reply",
      coerced: false,
    });
  });
});
