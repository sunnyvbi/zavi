import { describe, expect, it, vi } from "vitest";
import { makeProposeCampaignTool, type ProposeCampaignDeps } from "../propose_campaign";
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

function list(): ListSummary {
  return {
    id: LIST,
    name: "Regulars",
    created_at: "2026-10-26T00:00:00Z",
    latest: { id: VERSION, source_kind: "csv", source_label: "email", contact_count: 2, created_at: "2026-10-26T00:00:00Z", consented: true },
    active: { id: VERSION, source_kind: "csv", contact_count: 2, sendable: 2, unsubscribed_or_bounced: 0 },
    needs_consent: false,
  } as ListSummary;
}

function setup(replyTo: ProposeCampaignDeps["replyTo"]) {
  const emit = vi.fn(async (_cls: string, _body: unknown) => "2ff3de10-8154-4025-8100-4af14ad211d1");
  const releaseCard = vi.fn(async () => {});
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
    replyTo,
    learningsRead: async () => null,
    now: () => new Date("2026-10-27T08:00:00Z"),
    reserveCard: async () => ({ ok: true as const, id: "res-1" }),
    releaseCard,
    settleCard: async () => {},
  });
  const input = tool.input_schema.parse({
    route: "zavi_list",
    list_id: LIST,
    rationale: "Regulars hear first about the new cake.",
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
  return { run: () => tool.execute(ctx, input as Parameters<typeof tool.execute>[1]), emit, releaseCard };
}

describe("where replies go on a Zavi-list card", () => {
  it("an owner lookup that fails while drafting files no card and gives the slot back, instead of sealing no reply address", async () => {
    const s = setup(async () => {
      throw new Error("owner lookup failed");
    });
    await expect(s.run()).rejects.toMatchObject({ code: "bulk_check_failed", message: expect.stringMatching(/where replies to this email go/) });
    expect(s.emit).not.toHaveBeenCalled();
    expect(s.releaseCard).toHaveBeenCalledWith("7c70da58-091e-4ff5-8f77-343034d448d9", "res-1");
  });

  it("a founder with an email seals it on the card", async () => {
    const s = setup(async () => "founder@cakely.test");
    await s.run();
    expect(s.emit).toHaveBeenCalledTimes(1);
    expect((s.emit.mock.calls[0][1] as { reply_to: unknown }).reply_to).toBe("founder@cakely.test");
  });
});
