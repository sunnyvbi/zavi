
import { describe, expect, it } from "vitest";
import { actionsStoreFor, allowedActionTypes, type ActionType } from "@zavi/shared";
import { deriveActionType, type DerivableStep } from "../action-type";

const WAVE3 = ["geo", "email_marketing", "sms"] as const;

type Fixture = {
  shape: string;
  step: DerivableStep;
  staged?: string | null;
  expected?: ActionType;
};

const GEO: Fixture[] = [
  {
    shape: "team-subscription-tool",
    step: { title: "Draft the missing comparison page assistants keep citing", deliverable: { kind: "page_copy" } },
    expected: "page",
  },
  {
    shape: "team-subscription-tool",
    step: { title: "Replace the meta description on the two pages that rank", deliverable: { kind: "page_copy" } },
    expected: "fix",
  },
  {
    shape: "booking-led-local-service",
    step: { title: "Add the FAQ JSON-LD block so the answer can be lifted", deliverable: null },
    expected: "fix",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Write the article answering what the warranty covers", deliverable: { kind: "page_copy" } },
    expected: "text_post",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Confirm robots.txt allows the four named crawlers", deliverable: null },
    expected: "check",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Crawl the JS-free render and list what disappears", deliverable: null },
    expected: "check",
  },
  {
    shape: "paid-community",
    step: { title: "What the four brand questions are worth watching", deliverable: { kind: "brief" } },
    expected: "check",
  },
  {
    shape: "paid-community",
    step: { title: "Connect Search Console so the cited pages can be counted", deliverable: null },
  },
];

const EMAIL: Fixture[] = [
  {
    shape: "team-subscription-tool",
    step: { title: "Send email one the day after signup", deliverable: { kind: "email" } },
    expected: "send_message",
  },
  {
    shape: "booking-led-local-service",
    step: { title: "The re-booking broadcast for the quiet week", deliverable: { kind: "post" } },
    expected: "send_message",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Publish the DMARC record at p=none with a reporting address", deliverable: null },
    expected: "fix",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Suppress the hard bounces before the next send", deliverable: null },
    expected: "fix",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "The SPF record to publish alongside it", deliverable: { kind: "code" } },
    expected: "fix",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Signup form copy for the footer and the pricing page", deliverable: { kind: "page_copy" } },
    expected: "fix",
  },
  {
    shape: "paid-community",
    step: { title: "Verify the one-click unsubscribe header on a test send", deliverable: null },
    expected: "check",
  },
  {
    shape: "paid-community",
    step: { title: "What the lifecycle moments with no message are", deliverable: { kind: "brief" } },
    expected: "check",
  },
  {
    shape: "paid-community",
    step: { title: "Connect the email platform so campaign reports can be read", deliverable: null },
  },
];

const SMS: Fixture[] = [
  {
    shape: "team-subscription-tool",
    step: { title: "The STOP and HELP auto-replies, word for word", deliverable: { kind: "sms" } },
    expected: "send_message",
  },
  {
    shape: "booking-led-local-service",
    step: { title: "The reminder that fires the evening before", deliverable: { kind: "sms" } },
    expected: "send_message",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "The back-in-stock text for the people who asked", deliverable: { kind: "dm" } },
    expected: "send_message",
  },
  {
    shape: "two-sided-marketplace",
    step: {
      title: "The 10DLC campaign description with sample messages that match the opt-in",
      deliverable: { kind: "list" },
    },
    expected: "setup",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Start toll-free verification before buying a number", deliverable: null },
    expected: "setup",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "The opt-in checkbox text for the checkout", deliverable: { kind: "page_copy" } },
    expected: "fix",
  },
  {
    shape: "paid-community",
    step: { title: "Check whether a number is collected at all today", deliverable: null },
    expected: "check",
  },
  {
    shape: "paid-community",
    step: { title: "What the three layers each block on", deliverable: { kind: "brief" } },
    expected: "check",
  },
  {
    shape: "team-subscription-tool",
    step: { title: "The voice-note script for the follow-up call", deliverable: { kind: "script" } },
  },
];

const BY_CHANNEL: Record<(typeof WAVE3)[number], Fixture[]> = {
  geo: GEO,
  email_marketing: EMAIL,
  sms: SMS,
};

describe("wave 3: the three channels are switched", () => {
  it.each(WAVE3)("%s reads and writes channel_actions", (slug) => {
    expect(actionsStoreFor(slug)).toBe("channel_actions");
  });

  it("youtube_ads switched in wave 7, once its propose tools had a rail", () => {
    expect(actionsStoreFor("youtube_ads")).toBe("channel_actions");
  });
});

describe.each(WAVE3)("%s: derived type is always one the registry allows", (slug) => {
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
      const { action_type, coerced } = deriveActionType(slug, f.step, f.staged ?? null);
      expect(action_type, `${slug} / ${f.shape}`).toBe("other");
      expect(coerced, `${slug} / ${f.shape}: the fall-through must be COUNTED`).toBe(true);
      expect(allowedActionTypes(slug)).toContain(action_type);
    }
  });
});

describe("geo really does reach the page-first branch, not just seo", () => {
  const geo = (title: string, kind: string | null = "page_copy") =>
    deriveActionType("geo", { title, deliverable: kind ? { kind } : null }).action_type;

  it("a page that does not exist yet beats an edit noun in the same sentence", () => {
    expect(geo("Draft the missing pricing page with its title and meta description")).toBe("page");
  });

  it("an edit noun beats a write verb that happens to reach the word page", () => {
    expect(geo("Write the replacement title for the comparison page")).toBe("fix");
  });

  it("a read verb still wins on a step that hands nothing over", () => {
    expect(geo("Audit the structured data across the six crawled pages", null)).toBe("check");
    expect(geo("Confirm the canonical on the duplicate page", null)).toBe("check");
  });

  it("…but the same words as NOUNS, behind a repair verb, stay a fix", () => {
    expect(geo("Fix the two redirects the crawl found chaining", null)).toBe("fix");
  });

  it("page copy that names nothing keeps today's answer, `fix`", () => {
    expect(geo("Tighten the opening paragraph so it answers first")).toBe("fix");
  });
});

describe("the message-first branch, in both directions", () => {
  const derive = (slug: string, title: string, kind: string | null) =>
    deriveActionType(slug, { title, deliverable: kind ? { kind } : null }).action_type;

  it("anything published on these channels is a message, whatever kind the model picked", () => {
    for (const slug of ["email_marketing", "sms"] as const) {
      for (const kind of ["post", "thread", "comment", "dm", "email", "sms"]) {
        expect(derive(slug, "The message itself", kind), `${slug} / ${kind}`).toBe("send_message");
      }
    }
  });

  it("a read verb wins over the sender vocabulary in the same sentence", () => {
    expect(derive("email_marketing", "Confirm the DMARC record resolves", null)).toBe("check");
    expect(derive("email_marketing", "Review what the suppression list already holds", null)).toBe("check");
    expect(derive("sms", "Check the opt-in wording next to the phone field", null)).toBe("check");
    expect(derive("sms", "Verify the registration status before drafting", null)).toBe("check");
  });

  it("getting allowed to send is `setup` on sms and `fix` on email", () => {
    const titles = [
      "Publish the DMARC record for the sending domain",
      "Set the SPF record so it ends in ~all",
      "Warm up the new sending domain over three weeks",
      "Scrub the list before the launch send",
      "Finish the 10DLC registration with the carrier registry",
    ];
    for (const t of titles) {
      expect(derive("sms", t, null), `sms / ${t}`).toBe("setup");
      expect(derive("email_marketing", t, null), `email / ${t}`).toBe("fix");
    }
  });

  it("the registration kit arrives as `list` and is not left as `other`", () => {
    expect(derive("sms", "The 10DLC campaign description and sample messages", "list")).toBe("setup");
    expect(derive("email_marketing", "The opt-in records to keep for each address", "list")).toBe("fix");
  });

  it("a plain list that names nothing in that vocabulary stays `other`", () => {
    expect(derive("sms", "The three moments worth a text at all", "list")).toBe("other");
    expect(derive("email_marketing", "The ten questions people write back about", "list")).toBe("other");
  });

  it("page copy and a code snippet keep today's `fix` on both", () => {
    for (const slug of ["email_marketing", "sms"] as const) {
      expect(derive(slug, "The privacy policy clause to paste in", "page_copy")).toBe("fix");
      expect(derive(slug, "The snippet for the capture form", "code")).toBe("fix");
    }
  });

  it("an account connection is NOT in the sender vocabulary and is still counted", () => {
    expect(deriveActionType("email_marketing", { title: "Connect the email platform", deliverable: null })).toEqual({
      action_type: "other",
      coerced: true,
    });
    expect(derive("sms", "Connect a messaging provider once one exists", null)).toBe("setup");
  });

  it("the branch does not reach any other channel", () => {
    expect(derive("x_organic", "The message itself", "post")).toBe("text_post");
    expect(derive("seo", "Publish the DMARC record for the sending domain", null)).toBe("check");
  });
});
