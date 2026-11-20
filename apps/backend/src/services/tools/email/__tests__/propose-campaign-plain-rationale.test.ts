import { describe, expect, it, vi } from "vitest";
import { makeProposeCampaignTool, type ProposeCampaignDeps } from "../propose_campaign";
import { emailCampaignProposeSendTool } from "@/services/tools/email-campaign/propose_send";
import { plainRationale } from "@/services/tools/_shared/rationale";
import type { ListSummary } from "@/services/comms/bulk-outbound/lists";
import type { EmailTemplate } from "@/services/email-templates/render";

const LIST = "6b7a1c2e-1111-4222-8333-444455556666";
const VERSION = "7c8b2d3f-1111-4222-8333-444455556666";
const TEMPLATE: EmailTemplate = {
  logo_url: null,
  brand_color: "#111827",
  button_color: "#111827",
  font_key: "system",
  sign_off: "The cakely team",
  postal_address: "221 Baker Ave, Austin, TX 78702",
  show_cards: false,
};
const LEAKED =
  "Planned for Mon Nov 9, 10:00 UTC. Angle: tell regulars the new chocolate cake is out this week. Free-delivery suggestion left out because no page read this run confirms it.";
const BACKSTAGE_WORDS = /\brun\b|page read|pages? (?:i )?(?:read|checked)|__|instructions|tool call/i;

function list(): ListSummary {
  return {
    id: LIST,
    name: "QA messy 1026",
    created_at: "2026-10-26T00:00:00Z",
    latest: { id: VERSION, source_kind: "csv", source_label: "email", contact_count: 2, created_at: "2026-10-26T00:00:00Z", consented: true },
    active: { id: VERSION, source_kind: "csv", contact_count: 2, sendable: 2, unsubscribed_or_bounced: 0 },
    needs_consent: false,
  } as ListSummary;
}

function cakely() {
  const emit = vi.fn(async (_cls: string, _body: unknown) => "2ff3de10-8154-4025-8100-4af14ad211d1");
  const ctx = { tenant_id: "7c70da58-091e-4ff5-8f77-343034d448d9", log: () => {}, emit_decision: emit } as never;
  const tool = makeProposeCampaignTool({
    template: async () => TEMPLATE,
    company: async () => ({ name: "Cakely", website: "https://cakely.test" }),
    testLists: async () => new Set<string>(),
    checkSender: (async () => ({ ok: true, sender: { domain: "cakely.test", from_address: "hello@cakely.test", from_name: null }, postal_address: TEMPLATE.postal_address })) as unknown as ProposeCampaignDeps["checkSender"],
    lists: async () => [list()],
    source: () => ({
      async fetchCandidates() {
        return [
          { email: "a@x.com", opt_in_marketing: true },
          { email: "b@x.com", opt_in_marketing: true },
        ];
      },
    }),
    replyTo: async () => "founder@cakely.test",
    learningsRead: async () => null,
    now: () => new Date("2026-10-27T08:00:00Z"),
    reserveCard: async () => ({ ok: true as const, id: "res-1" }),
    releaseCard: async () => {},
    settleCard: async () => {},
  });
  return {
    async filedRationale(rationale: string): Promise<unknown> {
      const parsed = tool.input_schema.safeParse({
        route: "zavi_list",
        list_id: LIST,
        rationale,
        variants: [
          {
            subject: "The new chocolate cake is out this week",
            preview_text: "Fresh on the menu.",
            title: "Our new chocolate cake is out",
            paragraphs: ["You hear first: our new chocolate cake is out this week."],
            button: { label: "See the chocolate cake", url: "https://cakely.test" },
          },
        ],
      });
      if (!parsed.success) throw new Error(parsed.error.message);
      await tool.execute(ctx, parsed.data as Parameters<typeof tool.execute>[1]);
      expect(emit).toHaveBeenCalledTimes(1);
      const [cls, body] = emit.mock.calls[0];
      expect(cls).toBe("bulk_outbound.send");
      return (body as { rationale: unknown }).rationale;
    },
  };
}

describe("an email card's why reaches the founder without Zavi's backstage wording", () => {
  it("the Cakely card keeps the plan, the angle and what was left out, and drops the 'page read this run' reason", async () => {
    const filed = await cakely().filedRationale(LEAKED);
    expect(filed).toBe("Planned for Mon Nov 9, 10:00 UTC. Angle: tell regulars the new chocolate cake is out this week. Free-delivery suggestion left out.");
    expect(filed).not.toMatch(BACKSTAGE_WORDS);
  });

  it("a why made only of backstage wording files the card with no why at all", async () => {
    expect(await cakely().filedRationale("Read this run: email__list_plan returned 2 plans. Per my instructions, one email.")).toBeNull();
  });

  it("a plain why is stored byte for byte, with dots inside a link and the word 'runs' in its ordinary sense", async () => {
    const plain = "Spring sale runs until Friday, see cakely.test/sale.\nLast year's sale ran well; it lifted orders 12% (from your results).";
    expect(await cakely().filedRationale(plain)).toBe(plain);
  });

  it("the email-tool propose path (Mailchimp, Klaviyo, SendGrid) cleans the same wording", () => {
    const parsed = emailCampaignProposeSendTool.input_schema.parse({
      audience_id: "L1",
      subject: "s",
      body_text: "x",
      rationale: LEAKED,
    } as never) as { rationale?: string };
    expect(parsed.rationale).toBe("Planned for Mon Nov 9, 10:00 UTC. Angle: tell regulars the new chocolate cake is out this week. Free-delivery suggestion left out.");
  });

  it.each([
    ["Sent Tuesday because the pages I checked show a Monday closure.", "Sent Tuesday."],
    ["Uses last month's winner, as growth__read_action_outcomes showed.", "Uses last month's winner."],
    ["Short and friendly, since my instructions ask for one button.", "Short and friendly."],
    ["Nothing from this run.", ""],
    ["Tell regulars first. A promo code was left out: no source read confirms one.", "Tell regulars first. A promo code was left out."],
  ])("%s", (raw, want) => {
    expect(plainRationale(raw)).toBe(want);
  });
});

describe("a founder-facing why that only looks like backstage wording is stored as written", () => {
  const LEGIT = [
    "Links carry utm_campaign=spring__sale so the founder can see it in GA.",
    "Greets each reader with {{first__name}}, which the list fills in.",
    "Mailchimp merge field ORDER__COUNT drives the thank-you line.",
    "The pricing pages checked out fine, so the offer is safe to mention.",
    "Pushes the restock, since sources checked by our supplier confirm Friday delivery.",
    "Invites every run club member to the Saturday 5K, since they signed up at the expo.",
    "Recaps the last run of the season; the club ends Sunday.",
    "Promotes the limited print run, as that run sold out in two days last year.",
    "Sent Thursday because each run to the farmers market starts Friday.",
    "Reminds members to read the instructions on the box before baking.",
    "Keeps the weekly cadence, as your instructions asked for one email a week.",
    "Repeats the tool call-out from the newsletter, the drill sale.",
  ];

  it.each(LEGIT)("email-tool send: %s", (why) => {
    const parsed = emailCampaignProposeSendTool.input_schema.parse({ audience_id: "L1", subject: "s", body_text: "x", rationale: why } as never) as { rationale?: string };
    expect(parsed.rationale).toBe(why);
  });

  it.each(LEGIT)("Zavi list card: %s", async (why) => {
    expect(await cakely().filedRationale(why)).toBe(why);
  });

  it.each([
    ["Sent Tuesday, as this run found a Monday closure.", "Sent Tuesday."],
    ["Uses last month's winner, as mcp__slack__post showed.", "Uses last month's winner."],
    ["Uses last month's winner, as email__send reported 41% opens.", "Uses last month's winner."],
    ["Short and friendly, since I checked the page and it lists one offer.", "Short and friendly."],
    ["Free delivery left out because the previous run could not confirm it.", "Free delivery left out."],
    ["Free delivery left out because no page I fetched confirms it.", "Free delivery left out."],
    ["One button only, per my instructions.", "One button only."],
    ["Weekend send, as the tool result showed Saturday opens.", "Weekend send."],
  ])("still cleans %s", (raw, want) => {
    expect(plainRationale(raw)).toBe(want);
  });
});
