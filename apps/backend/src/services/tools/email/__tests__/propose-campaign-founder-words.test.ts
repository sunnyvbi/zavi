import { beforeEach, describe, expect, it, vi } from "vitest";

const LIST = "6b7a1c2e-1111-4222-8333-444455556666";
const VERSION = "7c8b2d3f-1111-4222-8333-444455556666";

const rpc = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantRpc: async (_tid: string, name: string) => {
    rpc.calls.push(name);
    if (name === "email_plan_run_context") return { data: { found: true, mode: null }, error: null };
    if (name === "reserve_email_card") return { data: { ok: true, id: "res-1" }, error: null };
    return { data: { ok: true }, error: null };
  },
}));
vi.mock("@/services/comms/bulk-outbound/readiness", async (orig) => {
  const real = await orig<typeof import("@/services/comms/bulk-outbound/readiness")>();
  return {
    ...real,
    checkBulkSender: async () => ({ ok: false as const, code: "sending_domain_not_verified" as const, sentence: real.BULK_REFUSAL_SENTENCES.sending_domain_not_verified }),
  };
});
vi.mock("@/services/comms/bulk-outbound/lists", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/lists")>()),
  listSummaries: async () => [
    {
      id: LIST,
      name: "Newsletter",
      created_at: "2026-10-07T00:00:00Z",
      latest: { id: VERSION, source_kind: "csv", source_label: "email", contact_count: 3, created_at: "2026-10-07T00:00:00Z", consented: true },
      active: { id: VERSION, source_kind: "csv", contact_count: 3, sendable: 3, unsubscribed_or_bounced: 0 },
      needs_consent: false,
    },
  ],
}));
vi.mock("@/services/tools/email-campaign/_exec-action", async (orig) => ({
  ...(await orig<typeof import("@/services/tools/email-campaign/_exec-action")>()),
  resolveEmailCampaignEmit: async () => null,
}));

import { callEmailTool } from "@/services/mcp/internal/email";
import { callOutboundTool } from "@/services/mcp/internal/outbound";
import { BULK_REFUSAL_SENTENCES } from "@/services/comms/bulk-outbound/readiness";
import { topActionFinalRefusal, topActionRetryPayload } from "@/services/channels/top-actions";

const RUN = "4b0d8c1e-3a59-4f6e-9a39-0f1f2b3c4d5e";
const PAYLOAD = {
  channel_slug: "email_marketing",
  top_action: { key: "new_email", by: "u1", inputs: { route: "zavi_list", list_id: LIST, brief: "Redraft the spring sale email" } },
};
const INTERNAL = /sending_domain_not_verified|bulk_email_ready|\bthe tool\b|\b[a-z]+_[a-z_]+\b/;

function founderText(content: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key: string | null) => {
    if (key === "error" || key === "id") return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, null));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(JSON.parse(content), null);
  return out;
}

beforeEach(() => {
  rpc.calls = [];
});

describe("an unverified Zavi sending domain reaches the model in founder words", () => {
  it("the propose refusal leads with the plain sentence, tells the model to relay it without codes, and stays a final refusal", async () => {
    const emit = vi.fn(async () => "card-1");
    const out = await callEmailTool("t-1", "propose_campaign", {
      route: "zavi_list",
      list_id: LIST,
      variants: [{ subject: "Spring sale", preview_text: "p", title: "t", paragraphs: ["a"], button: { label: "Shop", url: "https://acme.test" } }],
    }, { run_id: RUN, emit_decision: emit } as never);

    expect(out.is_error).toBe(true);
    const parsed = JSON.parse(out.content) as Record<string, unknown>;
    expect(Object.keys(parsed)[0]).toBe("message");
    expect(out.content.indexOf(BULK_REFUSAL_SENTENCES.sending_domain_not_verified)).toBeLessThan(out.content.indexOf("sending_domain_not_verified"));
    expect(parsed.message).toBe(
      `${BULK_REFUSAL_SENTENCES.sending_domain_not_verified} Nothing was proposed. Tell the founder exactly this, in these words, without any error code or field name.`,
    );
    expect(BULK_REFUSAL_SENTENCES.sending_domain_not_verified).toMatch(/add it if it is not there, then publish the DNS records/);
    for (const text of founderText(out.content)) expect(text).not.toMatch(INTERNAL);
    expect(emit).not.toHaveBeenCalled();
    expect(rpc.calls).toContain("release_email_card_reservation");

    const trace = [{ name: "mcp__server__email__propose_campaign", status: "tool_error", output_preview: out.content }];
    expect(topActionFinalRefusal(PAYLOAD, trace)).toEqual({ code: "sending_domain_not_verified" });
    expect(topActionRetryPayload(PAYLOAD, trace)).toBeNull();
  });

  it("the list read names no internal field, carries the plain sentence, and still stops the retry", async () => {
    const out = await callOutboundTool({ tenant_id: "t-1" }, "list_email_lists", {});

    expect(out.is_error).toBe(false);
    expect(out.content).not.toMatch(/bulk_email_ready|sending_domain_not_verified/);
    const parsed = JSON.parse(out.content) as { missing: string[]; from_address: string | null };
    expect(parsed.missing).toEqual([BULK_REFUSAL_SENTENCES.sending_domain_not_verified]);
    expect(parsed.from_address).toBeNull();
    for (const text of founderText(out.content)) expect(text).not.toMatch(INTERNAL);

    const trace = [{ name: "mcp__server__outbound__list_email_lists", status: "ok", output_preview: out.content }];
    expect(topActionFinalRefusal(PAYLOAD, trace)).toEqual({ code: "zavi_list_not_ready" });
    expect(topActionRetryPayload(PAYLOAD, trace)).toBeNull();
  });
});
