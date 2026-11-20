import { describe, it, expect, vi, beforeEach } from "vitest";

const { resolveBulkSender, replayBuildStage } = vi.hoisted(() => ({
  resolveBulkSender: vi.fn(),
  replayBuildStage: vi.fn(),
}));

vi.mock("@/services/comms/bulk-outbound/sending-domain", () => ({ resolveBulkSender }));
vi.mock("@/services/agents/build-replay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/build-replay")>()),
  replayBuildStage,
}));

import { runGeneric } from "@/services/agents/generic-dispatcher";
import { scrubAgentEgress } from "@/services/agents/scrub-agent-egress";
import { ownerTextsFromRows } from "@/services/agents/owner-turns";
import type { AgentContext } from "@/services/agents/types";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const SENDERS: Record<string, string> = {
  [TENANT_A]: "Hello@Acme-Shop.com",
  [TENANT_B]: "news@rival-store.com",
};

const payload = {
  owner_turn_texts: ownerTextsFromRows([{ sender_role: "user", body: "loop in broker@example-agency.com please" }], null),
};

const makeCtx = (slug: string, tenantId: string) =>
  ({
    tenant_id: tenantId,
    runId: `run-${slug}-${tenantId.slice(0, 4)}`,
    trigger: "chat",
    agent: { slug },
  }) as unknown as AgentContext;

beforeEach(() => {
  resolveBulkSender.mockReset();
  resolveBulkSender.mockImplementation(async (t: string) =>
    SENDERS[t] ? { domain: SENDERS[t].split("@")[1].toLowerCase(), from_address: SENDERS[t], from_name: null } : null,
  );
  replayBuildStage.mockReset();
  replayBuildStage.mockImplementation(async () => ({
    output_text: "Sends go from hello@acme-shop.com; broker@example-agency.com asked to be looped in.",
  }));
});

describe("runGeneric stamps the egress email allowlist per agent", () => {
  it("email_marketing gets exactly its own tenant's verified sender, read for ctx.tenant_id", async () => {
    const r = await runGeneric(makeCtx("email_marketing", TENANT_A), payload);
    expect(r.egress_email_allowlist).toEqual(["hello@acme-shop.com"]);
    expect(resolveBulkSender).toHaveBeenCalledTimes(1);
    expect(resolveBulkSender).toHaveBeenCalledWith(TENANT_A);
    const out = scrubAgentEgress(r.output_text, {
      surface: "chat",
      agentSlug: "email_marketing",
      scrubPii: true,
      keepEmails: r.egress_email_allowlist,
    }).text;
    expect(out).toBe("Sends go from hello@acme-shop.com; [redacted] asked to be looped in.");
  });

  it("email_marketing on another tenant gets that tenant's sender, never tenant A's", async () => {
    const r = await runGeneric(makeCtx("email_marketing", TENANT_B), payload);
    expect(r.egress_email_allowlist).toEqual(["news@rival-store.com"]);
    expect(resolveBulkSender).toHaveBeenCalledTimes(1);
    expect(resolveBulkSender).toHaveBeenCalledWith(TENANT_B);
  });

  it("email_marketing keeps nothing when the sender read fails", async () => {
    resolveBulkSender.mockRejectedValueOnce(new Error("We could not read your sending domain. Try again."));
    const r = await runGeneric(makeCtx("email_marketing", TENANT_A), payload);
    expect(r.egress_email_allowlist).toEqual([]);
  });

  it("cgo gets the owner-typed list and never reads a sender", async () => {
    const r = await runGeneric(makeCtx("cgo", TENANT_A), payload);
    expect(r.egress_email_allowlist).toEqual(["broker@example-agency.com"]);
    expect(resolveBulkSender).not.toHaveBeenCalled();
  });

  it("no other agent reads a sender", async () => {
    for (const slug of ["pm", "growth-lead", "support-lead", "operator", "email-marketing", "Email_Marketing"]) {
      const r = await runGeneric(makeCtx(slug, TENANT_A), payload);
      expect(r.egress_email_allowlist).toEqual(["broker@example-agency.com"]);
    }
    expect(resolveBulkSender).not.toHaveBeenCalled();
  });
});
