import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ record: vi.fn(), switched: vi.fn() }));
vi.mock("@/services/channels/exec-actions", () => ({ recordChannelExecAction: mocks.record }));
vi.mock("@/services/channels/channel-actions", () => ({ switchedChannelForRun: mocks.switched }));

import { makeProposeCampaignTool, type PlanRunContext, type ProposeCampaignDeps } from "@/services/tools/email/propose_campaign";
import { resolveEmailCampaignEmit } from "@/services/tools/email-campaign/_exec-action";
import { parseEmailSendBody } from "@/services/connectors/email-campaign/execute-send";
import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";
import { sendgridKeyDigest } from "@/services/connectors/email-campaign/credential";
import { BRIGHTLOOP_KEY, fakeSendgrid } from "@/services/connectors/email-campaign/__tests__/fake-sendgrid";
import { isPlannedCard } from "@/services/growth/cgo-email";
import type { EmailTemplate } from "@/services/email-templates/render";

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";

const T = "e575485d-311a-4152-9e7c-18373a63c6e5";
const RUN = "dc3e6779-a3f4-4a0e-b2ac-9a0a0f376d69";
const ITEM = "c42e928c-3b6c-4fd4-8c80-787cdc2de351";
const LIST = "2208e9ab-03f9-4944-80c1-3a13dd41ff60";
const CARD = "44444444-4444-4444-8444-444444444444";

const FAILED_RUN_INPUT = {
  route: "sendgrid",
  audience_id: LIST,
  variants: [
    {
      subject: "Diwali offer: 20% off Zavi",
      preview_text: "A festive thank-you from the Zavi team.",
      title: "Diwali offer from Zavi",
      hero: { big: "20% off for Diwali", small: "A festive thank-you from the Zavi team." },
      paragraphs: [
        "Happy Diwali from all of us at Zavi.",
        "To celebrate, we're offering 20% off. Name the number you want to move, and Zavi works out what's holding it back, proposes the work and does it once you approve.",
        "Open Zavi to take the offer.",
      ],
      button: { label: "Claim 20% off", url: "https://www.zaviagent.com" },
    },
    {
      subject: "Happy Diwali, 20% off Zavi",
      preview_text: "Our Diwali gift: 20% off.",
      title: "Happy Diwali from Zavi",
      hero: { big: "Happy Diwali", small: "Our gift to you: 20% off Zavi." },
      paragraphs: [
        "Wishing you a bright Diwali and a strong quarter ahead.",
        "For the festival, take 20% off Zavi. Pick one number to move, like signups or bookings, and let Zavi propose the work. Nothing runs without your approval.",
        "Visit Zavi to get started.",
      ],
      button: { label: "Visit Zavi", url: "https://www.zaviagent.com" },
    },
  ],
  rationale:
    'Planned for Tue Nov 10, 09:00 PT to the "test" list (5 people, read this run). Angle: Diwali 20% discount. Copy states only the 20% and your brief. No code, end date or plan scope was given, so none is invented. Before approving, confirm what the 20% applies to and how it is redeemed, and add that line if needed. Footer uses the saved postal address and unsubscribe group.',
};

const TEMPLATE: EmailTemplate = {
  logo_url: null,
  brand_color: "#0b8043",
  button_color: "#0b8043",
  font_key: "system",
  sign_off: "Thanks,\nThe Zavi team",
  postal_address: "12 Harbor Way, Portland OR 97201",
  show_cards: false,
};

const bound: PlanRunContext = { found: true, mode: "planned_draft", item_id: ITEM, version: 1, stale: false, route: "sendgrid", list_id: LIST };

type Attach = { item_id: string; version: number; run_id: string; rail: string; id: string };

function storedPayload(): Record<string, unknown> {
  return (mocks.record.mock.calls[0][0] as { execPayload: Record<string, unknown> }).execPayload;
}

async function realRailEmit() {
  const raw = vi.fn(async () => "decision-must-not-be-used");
  const emit = await resolveEmailCampaignEmit({ tenant_id: T, run_id: RUN, emit_decision: raw });
  return { emit: emit!, raw };
}

async function plannedDraft(over: Partial<ProposeCampaignDeps> = {}) {
  const sg = fakeSendgrid();
  sg.lists = [{ id: LIST, name: "test", contact_count: 5 }];
  const attachPlanned = vi.fn(async (_t: string, a: Attach) => {
    const body = storedPayload();
    if (body.planned_send_id !== a.item_id || body.plan_version !== a.version) return { ok: false, code: "not_this_plan" };
    return { ok: true };
  });
  const discardPlanned = vi.fn(async () => true);
  const releaseCard = vi.fn(async () => undefined);
  const settleCard = vi.fn(async () => undefined);
  const tool = makeProposeCampaignTool({
    resolveTool: (async () => ({ tool: "sendgrid", sendgrid: { api_key: BRIGHTLOOP_KEY, key_digest: sendgridKeyDigest(BRIGHTLOOP_KEY) } })) as never,
    callFor: () => sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch),
    template: async () => TEMPLATE,
    company: async () => ({ name: "Zavi", website: "https://www.zaviagent.com" }),
    testLists: async () => new Set<string>(),
    setting: async () => null,
    railOf: async () => "channel_actions",
    runContext: async () => bound,
    learningsRead: async () => ({ status: "empty", items: [] }),
    attachPlanned,
    discardPlanned,
    reserveCard: async () => ({ ok: true, id: "reservation-1" }),
    releaseCard,
    settleCard,
    now: () => new Date("2026-11-02T10:28:00Z"),
    ...over,
  });
  const { emit, raw } = await realRailEmit();
  const ctx = { tenant_id: T, run_id: RUN, emit_decision: emit, log: () => {} } as never;
  return { run: (input: unknown = FAILED_RUN_INPUT) => tool.execute(ctx, input as never), attachPlanned, discardPlanned, releaseCard, settleCard, raw };
}

beforeEach(() => {
  mocks.record.mockReset().mockResolvedValue({ id: CARD, replayed: false });
  mocks.switched.mockReset().mockResolvedValue("email_marketing");
});

describe("a planned draft on the real Email campaigns card writer", () => {
  it("files the card from run dc3e6779's exact input and attaches it to the plan item", async () => {
    const p = await plannedDraft();
    const out = await p.run();

    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(p.raw).not.toHaveBeenCalled();
    expect(storedPayload()).toMatchObject({ planned_send_id: ITEM, plan_version: 1, tool: "sendgrid", audience_id: LIST, audience_count: 5 });
    expect(p.attachPlanned).toHaveBeenCalledWith(T, { item_id: ITEM, version: 1, run_id: RUN, rail: "channel_actions", id: CARD });
    expect(p.discardPlanned).not.toHaveBeenCalled();
    expect(p.releaseCard).not.toHaveBeenCalled();
    expect(p.settleCard).toHaveBeenCalledWith(T, "reservation-1", CARD);
    expect(out).toMatchObject({ planned: true, card: { rail: "channel_actions", id: CARD }, versions: 2 });
  });

  it("keeps the binding through every read of the stored card, so Autopilot's door still sees a planned card", async () => {
    const p = await plannedDraft();
    await p.run();
    const payload = storedPayload();

    expect(isPlannedCard(payload)).toBe(true);
    expect(parseEmailSendBody(payload)).toMatchObject({ planned_send_id: ITEM, plan_version: 1 });
    expect(payload).not.toHaveProperty("rationale");
    expect((mocks.record.mock.calls[0][0] as { body: { step: { body: string } } }).body.step.body).toContain("confirm what the 20% applies to");
  });

  it("a redraft of a planned card reaches the rebind through the same writer", async () => {
    const OLD = { rail: "channel_actions", id: "33333333-3333-4333-8333-333333333333" };
    const rebindPlanned = vi.fn(async () => ({ ok: true }));
    const p = await plannedDraft({
      runContext: async () => ({ found: true, mode: null }),
      redraftPlan: async () => ({ item_id: ITEM, version: 1, status: "ready", open: true }),
      rebindPlanned,
      cardBody: async () => null,
    });
    await p.run({ ...FAILED_RUN_INPUT, replaces: OLD, changes: ["subject", "preview_text", "title", "paragraphs", "button"] });

    expect(storedPayload()).toMatchObject({ planned_send_id: ITEM, plan_version: 1 });
    expect(rebindPlanned).toHaveBeenCalledWith(T, { item_id: ITEM, version: 1, old: OLD, rail: "channel_actions", id: CARD });
  });

  it("an unplanned email to the same list carries no binding", async () => {
    const p = await plannedDraft({ runContext: async () => ({ found: true, mode: null }) });
    await p.run();

    expect(storedPayload()).not.toHaveProperty("planned_send_id");
    expect(storedPayload()).not.toHaveProperty("plan_version");
    expect(p.attachPlanned).not.toHaveBeenCalled();
  });

  it("still refuses what the card would not show, and a binding of the wrong shape", async () => {
    const p = await plannedDraft();
    await p.run();
    const good = storedPayload();
    mocks.record.mockClear();
    const { emit } = await realRailEmit();
    const refused = [
      { ...good, planned_send_id: "not an id" },
      { ...good, planned_send_id: 7 },
      { ...good, plan_version: "1" },
      { ...good, plan_version: 0 },
      { ...good, segment_id: 7 },
      { ...good, chosen_variant: 1 },
      { ...good, approved_count: 5 },
    ];
    for (const body of refused) {
      await expect(emit("email_campaign.create_and_send", body)).rejects.toMatchObject({ code: "email_campaign_body_invalid" });
    }
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
