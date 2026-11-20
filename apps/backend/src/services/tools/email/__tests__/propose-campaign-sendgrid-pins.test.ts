import { describe, expect, it, vi } from "vitest";
import { makeProposeCampaignTool, type ProposeCampaignDeps } from "@/services/tools/email/propose_campaign";
import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";
import { sendgridKeyDigest } from "@/services/connectors/email-campaign/credential";
import { BRIGHTLOOP_KEY, fakeSendgrid } from "@/services/connectors/email-campaign/__tests__/fake-sendgrid";

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";
const DIGEST = sendgridKeyDigest(BRIGHTLOOP_KEY);
const SG_LIST = "6a1f0c2e-0000-4000-8000-00000000b001";

function deps(sg: ReturnType<typeof fakeSendgrid>, settings: Record<string, string | null>): Partial<ProposeCampaignDeps> {
  return {
    resolveTool: (async () => ({ tool: "sendgrid", sendgrid: { api_key: BRIGHTLOOP_KEY, key_digest: DIGEST } })) as unknown as ProposeCampaignDeps["resolveTool"],
    callFor: () => sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch),
    template: async () => ({ logo_url: null, brand_color: "#1a73e8", button_color: "#0b8043", font_key: "system", sign_off: "Thanks", postal_address: "12 Harbor Way, Portland OR 97201", show_cards: false }),
    company: async () => ({ name: "Brightloop", website: "https://www.brightloop.test" }),
    testLists: async () => new Set<string>(),
    setting: async (_t, f) => settings[f] ?? null,
    railOf: async () => "channel_actions",
    replaceCard: async () => true,
    now: () => new Date("2026-10-11T12:00:00Z"),
    reserveCard: async () => ({ ok: true as const, id: "res-1" }),
    releaseCard: async () => {},
    settleCard: async () => {},
    learningsRead: async () => null,
  };
}

const v = { subject: "S", preview_text: "P", title: "T", paragraphs: ["x"], button: { label: "Go", url: "https://brightloop.test/x" } };

type EmitMock = { mock: { calls: unknown[][] } };

const ctx = (emit: unknown) => ({ tenant_id: "t", log: () => {}, emit_decision: emit }) as never;
const sealedIds = (emit: EmitMock) => {
  const b = emit.mock.calls[0][1] as Record<string, unknown>;
  return { sender: b.sendgrid_sender_id, group: b.sendgrid_suppression_group_id, from: b.from_email };
};

describe("SendGrid sender and unsubscribe group picked in Settings", () => {
  it("only the group is pinned and the account has no default group: the pinned group and the one verified sender are sealed", async () => {
    const sg = fakeSendgrid();
    sg.groups = [{ id: 7, name: "Product news", is_default: false }, { id: 8, name: "Billing", is_default: false }];
    const emit = vi.fn(async () => "44444444-4444-4444-8444-444444444444");
    await makeProposeCampaignTool(deps(sg, { sendgrid_suppression_group_id: "8" })).execute(ctx(emit), { route: "sendgrid", audience_id: SG_LIST, variants: [v] });
    expect(sealedIds(emit)).toEqual({ sender: "41", group: "8", from: "hello@brightloop.test" });
  });

  it("only the sender is pinned, two verified senders share its address: the pinned one and the default group are sealed", async () => {
    const sg = fakeSendgrid();
    sg.senders.push({ id: 43, from_email: "hello@brightloop.test", from_name: "Brightloop Support", verified: true });
    const emit = vi.fn(async () => "44444444-4444-4444-8444-444444444444");
    await makeProposeCampaignTool(deps(sg, { sendgrid_sender_id: "43" })).execute(ctx(emit), { route: "sendgrid", audience_id: SG_LIST, variants: [v] });
    expect(sealedIds(emit)).toEqual({ sender: "43", group: "7", from: "hello@brightloop.test" });
  });

  it("nothing pinned and two verified senders share the address: refused with a message that names the real problem", async () => {
    const sg = fakeSendgrid();
    sg.senders.push({ id: 43, from_email: "hello@brightloop.test", from_name: "Brightloop Support", verified: true });
    const emit = vi.fn(async () => "x");
    const p = makeProposeCampaignTool(deps(sg, {})).execute(ctx(emit), { route: "sendgrid", audience_id: SG_LIST, variants: [v], from_name: "Brightloop", from_email: "hello@brightloop.test" });
    await expect(p).rejects.toMatchObject({ code: "email_sender_unknown", message: expect.stringContaining("more than one verified sender in SendGrid uses hello@brightloop.test") });
    expect(emit).not.toHaveBeenCalled();
  });
});
