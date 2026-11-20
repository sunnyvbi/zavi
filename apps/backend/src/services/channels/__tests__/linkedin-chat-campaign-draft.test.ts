import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));

import { LINKEDIN_POST_PREVIEW_PENDING, stepDecisionBodies } from "@/agents/lib/channel-recipe-step";
import { recordChannelRunActions, type ScoreContext } from "../channel-actions";

const CTX: ScoreContext = {
  channel_in_plan: true,
  goal_metric_keys: new Set(),
  rejected_title_keys: new Set(),
  rejected_ids: new Set(),
};

const DRAFT_JSON = JSON.stringify({
  type: "campaign_draft",
  channel: "linkedin_ads",
  name: "Sweet Layers sponsored post",
  group_name: "Work and client occasions",
  rationale: "Smallest test of whether people who order for work occasions respond. Weak fit: the buyer is a person with an occasion, not a job title.",
  locations: [],
  audience_suggestions: { seniorities: ["Manager", "Senior"], staffCountRanges: ["11-50", "51-200"] },
});

const SHEET = [
  "Objective: Website visits. Classic, not Accelerate.",
  "Landing page: https://example.com/order",
  "Budget: [YOUR NUMBER, minimum $10/day] for 14 days",
  "",
  "VARIANT A: Pick and deliver",
  "Intro text (98/150): Birthdays, weddings, showers: pick a cake, choose a delivery day. Local delivery is included.",
  "Headline (38/70): Custom and ready-made cakes",
  "CTA: Learn More",
].join("\n");

function chatEnvelope(deliverable: Record<string, unknown>) {
  return {
    rendered_markdown: "Here is the draft as a card. Nothing is live.",
    steps: [
      {
        title: "Review the Sweet Layers sponsored post draft",
        body: "Weak fit, not a go. No post URN was read today. Pick a post or create one at review.",
        effort: "hours",
        how_to: ["Open Review and create on this card", "Add your delivery cities under Locations"],
        target: { ref: "Sweet Layers sponsored post (draft)", kind: "campaign" },
        blocking: false,
        evidence: ["LinkedIn Ads account 'Developer's Ad Account' (USD, open) read this thread"],
        deliverable,
      },
    ],
  };
}

const PARTS = [
  { label: "Variant A: Pick and deliver", content: "Intro text (98/150): Birthdays, weddings, showers.\nHeadline (38/70): Custom and ready-made cakes\nCTA: Learn More" },
  { label: "Variant B: Design your own", content: "Intro text (75/150): Design a custom cake.\nHeadline (20/70): Design your own cake\nCTA: Learn More" },
];

type Filed = { card_kind: string; primary_label: string; how_to: string[]; action_type: string; body: Record<string, any> };

async function file(env: ReturnType<typeof chatEnvelope>): Promise<Filed[]> {
  const rpc = vi.fn(async (_tid: unknown, name: string, _args: Record<string, unknown>) =>
    name === "record_channel_run_actions"
      ? { data: { inserted: 1, metrics: 0, stale_accepted: 0, stale_dropped: 0, ids: [] }, error: null }
      : { data: { ok: true }, error: null },
  );
  await recordChannelRunActions(
    { tenantId: "t-1", runId: "run-li-chat", channelSlug: "linkedin_ads", envelope: env, bodies: stepDecisionBodies(env), redo: null, chat: { toolCardIds: [] } },
    { rpc: rpc as never, loadScoreContext: async () => CTX, stagedPosts: async () => [], runExecs: async () => [], displace: vi.fn(async () => 0) as never },
  );
  const call = rpc.mock.calls.find((c) => c[1] === "record_channel_run_actions");
  return (call?.[2] as { p_actions: Filed[] }).p_actions;
}

function reviewable(a: Filed): boolean {
  const step = a.body.step;
  return step?.responsibility === "client" && step?.deliverable?.presentation?.type === "campaign_draft";
}

describe("a LinkedIn chat turn that writes the campaign draft into the copy", () => {
  it("files the draft written inside content, with parts, as a reviewable campaign_draft", async () => {
    const [card] = await file(chatEnvelope({ kind: "ad", label: "Sweet Layers LinkedIn campaign draft, two variants", parts: PARTS, content: `${DRAFT_JSON}\n\n${SHEET}` }));
    expect(card).toBeDefined();
    expect(reviewable(card)).toBe(true);
    const p = card.body.step.deliverable.presentation;
    expect(p).toMatchObject({ channel: "linkedin_ads", name: "Sweet Layers sponsored post", group_name: "Work and client occasions", post_preview: LINKEDIN_POST_PREVIEW_PENDING });
    expect(p.post_urn).toBeUndefined();
    expect(card.body.step.deliverable.content.startsWith("Objective: Website visits.")).toBe(true);
    expect(card.body.step.deliverable.content).not.toContain("\"campaign_draft\"");
    expect(card.how_to.join(" ")).not.toContain("Publish it, then press I created it.");
    expect(card.how_to.join(" ")).toContain("Zavi creates the campaign paused");
  });

  it("keeps a draft sent in presentation without post_preview instead of dropping the whole deliverable", async () => {
    const [card] = await file(chatEnvelope({ kind: "ad", label: "Sweet Layers draft", content: SHEET, presentation: JSON.parse(DRAFT_JSON) }));
    expect(card.body.step.deliverable).toBeDefined();
    expect(reviewable(card)).toBe(true);
    expect(card.body.step.deliverable.presentation.post_preview).toBe(LINKEDIN_POST_PREVIEW_PENDING);
  });

  it("leaves copy that only starts with a non-draft JSON object untouched", async () => {
    const content = `{"note":"not a draft"}\n\n${SHEET}`;
    const [card] = await file(chatEnvelope({ kind: "ad", label: "Copy sheet", content }));
    expect(card.body.step.deliverable.presentation).toBeUndefined();
    expect(card.body.step.deliverable.content).toBe(content);
    expect(card.primary_label).toBe("Copy ad");
    expect(card.how_to).toContain("Publish it, then press I created it.");
  });
});
