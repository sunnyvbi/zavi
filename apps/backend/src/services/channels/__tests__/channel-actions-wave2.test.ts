
import { describe, expect, it } from "vitest";
import { actionsStoreFor, allowedActionTypes, type ActionType } from "@zavi/shared";
import { deriveActionType, type DerivableStep } from "../action-type";

const WAVE2 = ["tiktok_organic", "youtube_organic", "seo"] as const;

type Fixture = {
  shape: string;
  step: DerivableStep;
  staged?: string | null;
  expected?: ActionType;
};

const TIKTOK: Fixture[] = [
  {
    shape: "team-subscription-tool",
    step: { title: "Shoot episode one to this script", deliverable: { kind: "script" } },
    expected: "video_post",
  },
  {
    shape: "booking-led-local-service",
    step: { title: "Shoot episode two in the same sitting", deliverable: { kind: "script" } },
    staged: "tiktok_video",
    expected: "video_post",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Leave the pinned comment that routes to the booking page", deliverable: { kind: "comment" } },
    expected: "reply",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Rewrite the profile bio's first line", deliverable: { kind: "page_copy" } },
    expected: "fix",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Reconnect the account so the queue can submit", deliverable: null },
    expected: "setup",
  },
  {
    shape: "paid-community",
    step: { title: "Confirm the link in the bio resolves logged out", deliverable: null },
    expected: "check",
  },
  {
    shape: "paid-community",
    step: { title: "The three slots worth posting in", deliverable: { kind: "list" } },
  },
];

const YOUTUBE: Fixture[] = [
  {
    shape: "team-subscription-tool",
    step: { title: "Film video one's first thirty seconds word for word", deliverable: { kind: "script" } },
    expected: "video_post",
  },
  {
    shape: "booking-led-local-service",
    step: { title: "Cut the companion short from the same footage", deliverable: { kind: "script" } },
    staged: "youtube_video",
    expected: "video_post",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Post the pinned comment with the destination link", deliverable: { kind: "comment" } },
    expected: "reply",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Replace the channel description's first two lines", deliverable: { kind: "page_copy" } },
    expected: "fix",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Claim the handle before the first upload", deliverable: null },
    expected: "setup",
  },
  {
    shape: "paid-community",
    step: { title: "Pull the retention curve for the two videos read this run", deliverable: null },
    expected: "check",
  },
  {
    shape: "paid-community",
    step: { title: "Send the outline to the two named creators", deliverable: { kind: "dm" } },
  },
];

const SEO: Fixture[] = [
  {
    shape: "team-subscription-tool",
    step: { title: "Replace the titles and meta descriptions on three pages", deliverable: { kind: "page_copy" } },
    expected: "fix",
  },
  {
    shape: "team-subscription-tool",
    step: { title: "Draft the missing comparison page for the shortlist query", deliverable: { kind: "page_copy" } },
    expected: "page",
  },
  {
    shape: "booking-led-local-service",
    step: { title: "Build the landing page for the neighbourhood query", deliverable: { kind: "page_copy" } },
    expected: "page",
  },
  {
    shape: "booking-led-local-service",
    step: { title: "Add the FAQ JSON-LD block to the home page", deliverable: null },
    expected: "fix",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Write the blog post answering the sizing question", deliverable: { kind: "page_copy" } },
    expected: "text_post",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Fix the two redirects the crawl found chaining", deliverable: null },
    expected: "fix",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Audit the sitemap and count the URLs it lists", deliverable: null },
    expected: "check",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Research which of the three phrasings buyers actually type", deliverable: null },
    expected: "check",
  },
  {
    shape: "paid-community",
    step: { title: "What the four queries are worth watching", deliverable: { kind: "brief" } },
    expected: "check",
  },
  {
    shape: "paid-community",
    step: { title: "Connect Search Console so positions can be read", deliverable: null },
  },
];

const BY_CHANNEL: Record<(typeof WAVE2)[number], Fixture[]> = {
  tiktok_organic: TIKTOK,
  youtube_organic: YOUTUBE,
  seo: SEO,
};

describe("wave 2: the three channels are switched", () => {
  it.each(WAVE2)("%s reads and writes channel_actions", (slug) => {
    expect(actionsStoreFor(slug)).toBe("channel_actions");
  });

});

describe.each(WAVE2)("%s: derived type is always one the registry allows", (slug) => {
  const fixtures = BY_CHANNEL[slug];

  it("covers at least 3 different business shapes", () => {
    expect(new Set(fixtures.map((f) => f.shape)).size).toBeGreaterThanOrEqual(3);
  });

  it("every fixture derives a type inside this channel's action_types", () => {
    const allowed = allowedActionTypes(slug);
    expect(allowed.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      const { action_type } = deriveActionType(slug, f.step, f.staged ?? null);
      expect(allowed, `${slug} / ${f.shape} / ${String(f.step.title)}`).toContain(action_type);
    }
  });

  it("derives the type each per-channel rule calls for", () => {
    for (const f of fixtures) {
      if (!f.expected) continue;
      const { action_type, coerced } = deriveActionType(slug, f.step, f.staged ?? null);
      expect(action_type, `${slug} / ${f.shape} / ${String(f.step.title)}`).toBe(f.expected);
      expect(coerced, `${slug} / ${f.shape}: an expected type must not be a coercion`).toBe(false);
    }
  });

  it("a fixture with no expected type falls to `other`, which is always allowed", () => {
    for (const f of fixtures) {
      if (f.expected) continue;
      const { action_type } = deriveActionType(slug, f.step, f.staged ?? null);
      expect(action_type, `${slug} / ${f.shape}`).toBe("other");
      expect(allowedActionTypes(slug)).toContain(action_type);
    }
  });
});

describe("seo: the page-first precedence, in both directions", () => {
  const page = (title: string, kind: string | null = "page_copy") =>
    deriveActionType("seo", { title, deliverable: kind ? { kind } : null }).action_type;

  it("a page the step says does not exist beats an edit noun in the same sentence", () => {
    expect(page("Draft the missing /pricing page with its title and meta description")).toBe("page");
    expect(page("Write the new comparison page, including the H1")).toBe("page");
  });

  it("an edit noun beats a write verb that happens to reach the word page", () => {
    expect(page("Write the replacement title for the /services page")).toBe("fix");
    expect(page("Update the meta description on the blog index page")).toBe("fix");
    expect(page("Replace the titles on three pages")).toBe("fix");
  });

  it("a create verb reaching a page, with nothing else named, is a new page", () => {
    expect(page("Draft the page for the question buyers ask before they book")).toBe("page");
    expect(page("Publish the landing page for the second service line")).toBe("page");
  });

  it("an article is a text post, a page of the site is not", () => {
    expect(page("Write the blog post answering the deposit question")).toBe("text_post");
    expect(page("Publish the 900-word article on what the fee covers")).toBe("text_post");
  });

  it("the site's own machinery reads as an edit, with or without a deliverable", () => {
    for (const kind of ["page_copy", null] as const) {
      expect(page("Add the FAQ schema block to the home page", kind)).toBe("fix");
      expect(page("Fix the sitemap so the child sitemaps resolve", kind)).toBe("fix");
      expect(page("Point the two chained redirects straight at the target", kind)).toBe("fix");
      expect(page("Add the tracking snippet to the thank-you page", kind)).toBe("fix");
      expect(page("Give the three images alt text", kind)).toBe("fix");
    }
  });

  it("a read verb still wins on a step that hands nothing over", () => {
    expect(page("Audit the titles across the six crawled pages", null)).toBe("check");
    expect(page("Research the phrasing buyers use for the sitemap question", null)).toBe("check");
    expect(page("Confirm the canonical on the duplicate page", null)).toBe("check");
    expect(page("Crawl the internal links and list the ones that 404", null)).toBe("check");
  });

  it("…but the same words as NOUNS, behind a repair verb, stay a fix", () => {
    expect(page("Fix the two redirects the crawl found chaining", null)).toBe("fix");
    expect(page("Replace the titles the audit flagged as duplicates")).toBe("fix");
  });

  it("page copy that names nothing keeps today's answer, `fix`", () => {
    expect(page("Tighten the opening paragraph")).toBe("fix");
  });
});

describe("the video channels needed no new rule", () => {
  it("a script is a video on both, staged or not", () => {
    for (const slug of ["tiktok_organic", "youtube_organic"] as const) {
      expect(deriveActionType(slug, { title: "Shoot it", deliverable: { kind: "script" } }).action_type).toBe(
        "video_post",
      );
    }
    expect(
      deriveActionType("tiktok_organic", { title: "Shoot it", deliverable: { kind: "post" } }, "tiktok_video")
        .action_type,
    ).toBe("video_post");
    expect(
      deriveActionType("youtube_organic", { title: "Shoot it", deliverable: { kind: "post" } }, "youtube_video")
        .action_type,
    ).toBe("video_post");
  });

  it("the page-first branch does not reach them: a bio rewrite is still a fix", () => {
    expect(
      deriveActionType("tiktok_organic", {
        title: "Draft the new page the bio links to",
        deliverable: { kind: "page_copy" },
      }).action_type,
    ).toBe("fix");
  });
});
