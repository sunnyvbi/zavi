import { describe, it, expect } from "vitest";

import {
  resolveChannelAction,
  validateChannelPayload,
  buildConfiguredProps,
  SOCIAL_CHANNEL_ACTIONS,
} from "../social-channels";
import { nativeChannelFor } from "../social-publish-account";
import { authSlotFor } from "../pipedream/api";

describe("resolveChannelAction", () => {
  it("returns the entry for linkedin (personal feed, live-verified id)", () => {
    const entry = resolveChannelAction("linkedin");
    expect(entry.app_slug).toBe("linkedin");
    expect(entry.action_id).toBe("linkedin-create-text-post-user");
    expect(entry.enabled).toBe(true);
    expect(entry.destination_required).toBe(false);
  });

  it("returns the entry for reddit (live-verified id)", () => {
    const entry = resolveChannelAction("reddit");
    expect(entry.app_slug).toBe("reddit");
    expect(entry.action_id).toBe("reddit-submit-a-post");
    expect(entry.enabled).toBe(true);
  });

  it("throws for an unknown channel (myspace)", () => {
    expect(() => resolveChannelAction("myspace")).toThrow(/unknown channel/);
  });

  it("resolves x (enabled 2026-09-08; X bills Zavi's app per post)", () => {
    const entry = resolveChannelAction("x");
    expect(entry.enabled).toBe(true);
    expect(entry.cost).toBe("paid");
  });

  it("refuses linkedin_org — it was removed, not disabled", () => {
    expect(() => resolveChannelAction("linkedin_org")).toThrow(/unknown channel/);
  });

  it("carries no channel whose id was never live-verified", () => {
    expect(Object.keys(SOCIAL_CHANNEL_ACTIONS).sort()).toEqual([
      "instagram_image",
      "instagram_video",
      "linkedin",
      "linkedin_image",
      "linkedin_video",
      "pinterest_pin",
      "reddit",
      "reddit_comment",
      "tiktok_video",
      "x",
      "x_image",
      "x_video",
      "youtube_video",
    ]);
  });

  it("tiktok_video's unprobed ids stay unreachable (native-only)", () => {
    expect(nativeChannelFor("tiktok_video"), "tiktok_video must be registered in NATIVE_CHANNELS").toBeTruthy();
  });

  it("the Library video channels publish natively, never through their unprobed Pipedream ids", () => {
    expect(nativeChannelFor("instagram_video"), "instagram_video must be registered in NATIVE_CHANNELS").toBeTruthy();
    expect(nativeChannelFor("linkedin_video"), "linkedin_video must be registered in NATIVE_CHANNELS").toBeTruthy();
  });
});

describe("validateChannelPayload — linkedin", () => {
  it("accepts a valid text payload", () => {
    expect(validateChannelPayload("linkedin", { text: "hello" })).toEqual({
      text: "hello",
    });
  });

  it("accepts text exactly at the 3000 limit", () => {
    const atLimit = "a".repeat(3000);
    expect(validateChannelPayload("linkedin", { text: atLimit })).toEqual({
      text: atLimit,
    });
  });

  it("rejects over-limit text (>3000)", () => {
    expect(() =>
      validateChannelPayload("linkedin", { text: "a".repeat(3001) }),
    ).toThrow();
  });

  it("rejects empty text", () => {
    expect(() => validateChannelPayload("linkedin", { text: "" })).toThrow();
  });

  it.each(["image", "media", "video", "attachment"])(
    "rejects a payload carrying a %s key (strict schema)",
    (key) => {
      expect(() =>
        validateChannelPayload("linkedin", { text: "hi", [key]: "x" }),
      ).toThrow();
    },
  );

  it("refuses to validate against a disabled channel (resolve gate runs first)", () => {
    expect(() => validateChannelPayload("myspace", { text: "hi" })).toThrow(/unknown channel/);
  });
});

describe("validateChannelPayload — reddit", () => {
  const ok = { subreddit: "SaaS", title: "How we cut churn", text: "body" };

  it("accepts a valid self-post payload", () => {
    expect(validateChannelPayload("reddit", ok)).toEqual(ok);
  });

  it("rejects a missing subreddit", () => {
    expect(() =>
      validateChannelPayload("reddit", { title: "t", text: "b" }),
    ).toThrow();
  });

  it("rejects a missing title", () => {
    expect(() =>
      validateChannelPayload("reddit", { subreddit: "SaaS", text: "b" }),
    ).toThrow();
  });

  it("rejects an over-limit title (>300)", () => {
    expect(() =>
      validateChannelPayload("reddit", { ...ok, title: "a".repeat(301) }),
    ).toThrow();
  });

  it.each(["r/SaaS", "SaaS/../evil", "SaaS?x=1", "https://reddit.com/r/SaaS", "a b"])(
    "rejects a non-bare subreddit name (%s) so the target can't be redirected",
    (sub) => {
      expect(() => validateChannelPayload("reddit", { ...ok, subreddit: sub })).toThrow();
    },
  );

  it("rejects a `kind` key — the model must not choose link/image", () => {
    expect(() =>
      validateChannelPayload("reddit", { ...ok, kind: "link" }),
    ).toThrow();
  });

  it("rejects a `url` key — no link-smuggling on a self post", () => {
    expect(() =>
      validateChannelPayload("reddit", { ...ok, url: "https://evil.example" }),
    ).toThrow();
  });
});

describe("buildConfiguredProps", () => {
  it("adds the REQUIRED linkedin `visibility` prop the agent never supplies", () => {
    expect(buildConfiguredProps("linkedin", { text: "hello" })).toEqual({
      text: "hello",
      visibility: "PUBLIC",
    });
  });

  it("server-fixes reddit `kind` to self and passes the validated fields", () => {
    expect(
      buildConfiguredProps("reddit", {
        subreddit: "SaaS",
        title: "t",
        text: "b",
      }),
    ).toEqual({ subreddit: "SaaS", title: "t", kind: "self", text: "b" });
  });

  it("never emits a key the validated payload did not carry", () => {
    const props = buildConfiguredProps("linkedin", { text: "hello" });
    expect(Object.keys(props).sort()).toEqual(["text", "visibility"]);
  });
});

describe("authSlotFor — the Pipedream app-prop name", () => {
  it("defaults to the app slug when they match", () => {
    expect(authSlotFor("linkedin")).toBe("linkedin");
    expect(authSlotFor("reddit")).toBe("reddit");
  });

  it("overrides the three apps whose slot name differs from the slug", () => {
    expect(authSlotFor("twitter")).toBe("app");
    expect(authSlotFor("instagram_business")).toBe("instagram");
    expect(authSlotFor("youtube_data_api")).toBe("youtubeDataApi");
  });

  it("covers every app slug the channel map can reach", () => {
    for (const entry of Object.values(SOCIAL_CHANNEL_ACTIONS)) {
      expect(typeof authSlotFor(entry.app_slug)).toBe("string");
    }
  });
});

describe("linkedin_image — media channel", () => {
  const OK_PATH = "73db45ff-457e-4541-bc8f-bdb625390204/8f14e45f-ceea-467a-a2f4-1d2c3b4a5e6f.jpg";

  it("resolves to the live-verified image action + declares its media prop", () => {
    const e = resolveChannelAction("linkedin_image");
    expect(e.action_id).toBe("linkedin-create-image-post-user");
    expect(e.app_slug).toBe("linkedin");
    expect(e.media_prop).toBe("file");
  });

  it("accepts a well-formed storage path", () => {
    expect(
      validateChannelPayload("linkedin_image", { text: "hi", image_path: OK_PATH }),
    ).toEqual({ text: "hi", image_path: OK_PATH });
  });

  it.each([
    ["an https URL", "https://evil.example/x.jpg"],
    ["a bare filename", "x.jpg"],
    ["a traversal attempt", "../other-tenant/x.jpg"],
    ["a non-image extension", "73db45ff-457e-4541-bc8f-bdb625390204/8f14e45f-ceea-467a-a2f4-1d2c3b4a5e6f.svg"],
  ])("rejects %s as image_path", (_label, bad) => {
    expect(() =>
      validateChannelPayload("linkedin_image", { text: "hi", image_path: bad }),
    ).toThrow();
  });

  it("rejects a payload with no image_path (it is REQUIRED)", () => {
    expect(() => validateChannelPayload("linkedin_image", { text: "hi" })).toThrow();
  });

  it("puts the PATH (not a URL) in the frozen props, under the live prop name", () => {
    const props = buildConfiguredProps("linkedin_image", {
      text: "hi",
      image_path: OK_PATH,
    });
    expect(props).toEqual({ file: OK_PATH, text: "hi", visibility: "PUBLIC" });
    expect(String(props.file)).not.toMatch(/^https?:/);
  });

  it("only the media channel declares media_prop — text channels must not", () => {
    expect(resolveChannelAction("linkedin").media_prop).toBeUndefined();
    expect(resolveChannelAction("reddit").media_prop).toBeUndefined();
  });
});

describe("validateChannelPayload — instagram_image / youtube_video (2026-09-03)", () => {
  const T = "73db45ff-457e-4541-bc8f-bdb625390204";
  const IMG = `${T}/9ff27fce-9f83-4c1a-9a1e-0b2c3d4e5f60.jpg`;
  const VID = `${T}/9ff27fce-9f83-4c1a-9a1e-0b2c3d4e5f60.mp4`;

  it("instagram_image accepts caption + image_path and builds {file, text}", () => {
    const v = validateChannelPayload("instagram_image", { text: "cap", image_path: IMG });
    expect(buildConfiguredProps("instagram_image", v)).toEqual({ file: IMG, text: "cap" });
  });

  it("instagram_image rejects a URL, a video path, an over-long caption and an unknown key", () => {
    expect(() => validateChannelPayload("instagram_image", { text: "c", image_path: "https://evil/x.jpg" })).toThrow();
    expect(() => validateChannelPayload("instagram_image", { text: "c", image_path: VID })).toThrow();
    expect(() => validateChannelPayload("instagram_image", { text: "c".repeat(2201), image_path: IMG })).toThrow();
    expect(() => validateChannelPayload("instagram_image", { text: "c", image_path: IMG, visibility: "PUBLIC" })).toThrow();
  });

  it("youtube_video accepts title + text + video_path, defaults privacy to public, builds {file,title,text,privacy}", () => {
    const v = validateChannelPayload("youtube_video", { title: "Launch", text: "desc", video_path: VID });
    expect(v.privacy).toBe("public");
    expect(buildConfiguredProps("youtube_video", v)).toEqual({ file: VID, title: "Launch", text: "desc", privacy: "public" });
  });

  it("youtube_video rejects a URL, an image path, a >100 title, a bad privacy value and an unknown key", () => {
    expect(() => validateChannelPayload("youtube_video", { title: "t", text: "d", video_path: "https://evil/v.mp4" })).toThrow();
    expect(() => validateChannelPayload("youtube_video", { title: "t", text: "d", video_path: IMG })).toThrow();
    expect(() => validateChannelPayload("youtube_video", { title: "t".repeat(101), text: "d", video_path: VID })).toThrow();
    expect(() => validateChannelPayload("youtube_video", { title: "t", text: "d", video_path: VID, privacy: "everyone" })).toThrow();
    expect(() => validateChannelPayload("youtube_video", { title: "t", text: "d", video_path: VID, tags: ["x"] })).toThrow();
  });

  it("both are media channels whose media_prop is `file`", () => {
    expect(resolveChannelAction("instagram_image").media_prop).toBe("file");
    expect(resolveChannelAction("youtube_video").media_prop).toBe("file");
  });
});

import { SOCIAL_LIMITS } from "@zavi/shared";

describe("SOCIAL_LIMITS parity with the channel schemas", () => {
  const fill = (channel: string, textLen: number, titleLen?: number): Record<string, unknown> => {
    const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
    const base: Record<string, unknown> = { text: "a".repeat(textLen) };
    if (channel === "reddit") Object.assign(base, { subreddit: "SaaS", title: "t".repeat(titleLen ?? 1) });
    if (channel === "reddit_comment") base.thread_url = "https://www.reddit.com/r/SaaS/comments/1abcde/";
    if (channel === "linkedin_image" || channel === "instagram_image" || channel === "x_image")
      base.image_path = `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.jpg`;
    if (channel === "x_video" || channel === "linkedin_video" || channel === "instagram_video") base.video_path = `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.mp4`;
    if (channel === "youtube_video")
      Object.assign(base, { title: "t".repeat(titleLen ?? 1), video_path: `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.mp4` });
    if (channel === "tiktok_video") base.video_path = `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.mp4`;
    if (channel === "pinterest_pin")
      Object.assign(base, {
        title: "t".repeat(titleLen ?? 1),
        image_path: `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.jpg`,
        board_id: "971159175836868903",
        link: "https://acme.com/p/duvet",
      });
    return base;
  };
  const schemaFor = (channel: string) => SOCIAL_CHANNEL_ACTIONS[channel as keyof typeof SOCIAL_CHANNEL_ACTIONS].payload_schema;

  it("every SOCIAL_LIMITS key is a channel in the committed map", () => {
    for (const ch of Object.keys(SOCIAL_LIMITS)) expect(SOCIAL_CHANNEL_ACTIONS).toHaveProperty(ch);
  });

  it("text: cap passes, cap+1 throws, per channel (x via the schema — the channel is disabled)", () => {
    for (const [ch, lim] of Object.entries(SOCIAL_LIMITS)) {
      const s = schemaFor(ch);
      expect(s.safeParse(fill(ch, lim.text)).success, `${ch} text=${lim.text}`).toBe(true);
      expect(s.safeParse(fill(ch, lim.text + 1)).success, `${ch} text=${lim.text + 1}`).toBe(false);
    }
  });

  it("title: cap passes, cap+1 throws, where a title exists", () => {
    for (const [ch, lim] of Object.entries(SOCIAL_LIMITS)) {
      if (!("title" in lim)) continue;
      const s = schemaFor(ch);
      expect(s.safeParse(fill(ch, 1, lim.title)).success, `${ch} title=${lim.title}`).toBe(true);
      expect(s.safeParse(fill(ch, 1, lim.title + 1)).success, `${ch} title=${lim.title + 1}`).toBe(false);
    }
  });

  it("vendor_review_pending strings are the shared ones (the web shows them without importing this module)", () => {
    for (const [ch, lim] of Object.entries(SOCIAL_LIMITS)) {
      const entry = SOCIAL_CHANNEL_ACTIONS[ch as keyof typeof SOCIAL_CHANNEL_ACTIONS];
      expect(entry.vendor_review_pending ?? undefined).toBe(
        (lim as { vendor_review_pending?: string }).vendor_review_pending ?? undefined,
      );
    }
  });
});

describe("x_image / x_video — media channels on the native X transport", () => {
  it("resolve with a media prop and refuse a URL where a storage path belongs", () => {
    const img = resolveChannelAction("x_image");
    expect(img.media_prop).toBe("file");
    expect(img.enabled).toBe(true);
    expect(() => validateChannelPayload("x_image", { text: "t", image_path: "https://evil.example/a.jpg" })).toThrow();
    expect(validateChannelPayload("x_image", { text: "t", image_path: "73db45ff-457e-4541-bc8f-bdb625390204/9f9f9f9f-0000-4000-8000-000000000000.jpg" })).toBeTruthy();
    expect(validateChannelPayload("x_video", { text: "t", video_path: "73db45ff-457e-4541-bc8f-bdb625390204/9f9f9f9f-0000-4000-8000-000000000000.mp4" })).toBeTruthy();
  });

  it("no thread with media — the strict schema rejects it", () => {
    expect(() =>
      validateChannelPayload("x_image", { text: "t", image_path: "73db45ff-457e-4541-bc8f-bdb625390204/9f9f9f9f-0000-4000-8000-000000000000.jpg", thread: ["x"] }),
    ).toThrow();
  });
});

describe("pinterest_pin — Composio-only image pin", () => {
  const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
  const pin = {
    title: "Linen duvet cover",
    text: "Stonewashed linen.",
    image_path: `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.jpg`,
    board_id: "971159175836868903",
    board_name: "Linen bedding",
    link: "https://acme.com/p/duvet",
  };
  it("is a media channel with no native publisher (Composio is its only door)", () => {
    expect(resolveChannelAction("pinterest_pin").media_prop).toBe("file");
    expect(nativeChannelFor("pinterest_pin")).toBeNull();
  });
  it("refuses a non-https link, a URL-shaped image and a non-numeric board", () => {
    expect(() => validateChannelPayload("pinterest_pin", { ...pin, link: "http://acme.com" })).toThrow();
    expect(() => validateChannelPayload("pinterest_pin", { ...pin, image_path: "https://evil.example/i.jpg" })).toThrow();
    expect(() => validateChannelPayload("pinterest_pin", { ...pin, board_id: "../boards" })).toThrow();
  });
  it("sends the board id and link but never the display-only board name", () => {
    const props = buildConfiguredProps("pinterest_pin", validateChannelPayload("pinterest_pin", pin));
    expect(props).toEqual({ file: pin.image_path, title: pin.title, text: pin.text, board_id: pin.board_id, link: pin.link });
  });
});

describe("reddit_comment", () => {
  const URL = "https://www.reddit.com/r/SaaS/comments/1abcde/how_do_you_find_users/";
  it("freezes the canonical thread and the text", () => {
    const p = validateChannelPayload("reddit_comment", { thread_url: URL, text: "Here is what worked for us." });
    expect(resolveChannelAction("reddit_comment").buildProps(p)).toEqual({
      thread_url: "https://www.reddit.com/r/saas/comments/1abcde/",
      text: "Here is what worked for us.",
    });
  });
  it("refuses a non-thread URL, an extra key and empty text", () => {
    expect(() => validateChannelPayload("reddit_comment", { thread_url: "https://example.com/r/x/comments/1/", text: "a" })).toThrow();
    expect(() => validateChannelPayload("reddit_comment", { thread_url: "https://www.reddit.com/r/SaaS/", text: "a" })).toThrow();
    expect(() => validateChannelPayload("reddit_comment", { thread_url: URL, text: "a", thing_id: "t3_zzz" })).toThrow();
    expect(() => validateChannelPayload("reddit_comment", { thread_url: URL, text: "" })).toThrow();
  });
  it("has the native Reddit connector as its backup", () => {
    expect(nativeChannelFor("reddit_comment")).toBe(nativeChannelFor("reddit"));
  });
});

describe("X counted length", () => {
  const longLink = "Read more https://example.com/" + "a".repeat(290);
  const image = "00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002.jpg";
  it.each(["x", "x_image", "x_video"])("%s accepts a long URL unchanged and refuses weighted overflow", channel => {
    const extra = channel === "x_image" ? { image_path: image } : channel === "x_video" ? { video_path: image.replace(".jpg", ".mp4") } : {};
    expect(validateChannelPayload(channel, { text: longLink, ...extra }).text).toBe(longLink);
    expect(() => validateChannelPayload(channel, { text: "界".repeat(141), ...extra })).toThrow();
  });
  it("applies the same counted limit to every tail part", () => {
    expect(validateChannelPayload("x", { text: "root", thread: [longLink] }).thread).toEqual([longLink]);
    expect(() => validateChannelPayload("x", { text: "root", thread: ["界".repeat(141)] })).toThrow();
  });
});
