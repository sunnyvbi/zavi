
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  pendingRows: [] as Array<Record<string, unknown>>,
  claimError: null as { message: string } | null,
  claimFresh: true,
  emailOutcome: { sent: true, count: 1 } as { sent: boolean; count?: number; reason?: string },
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  updateCalls: 0,
}));

vi.mock("@/email/sendMaterialNewsDigest", () => ({
  sendMaterialNewsDigestEmail: vi.fn(async () => h.emailOutcome),
}));

function chainFor(table: string) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "is", "order", "limit", "maybeSingle", "gte", "lt", "in", "delete"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.update = vi.fn(() => {
    if (table === "news_findings") h.updateCalls += 1;
    return chain;
  });
  chain.insert = vi.fn(() => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }));
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) =>
    r({ data: table === "news_findings" ? h.pendingRows : [], error: null });
  return chain;
}
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (x: string) => x,
  tenantClient: () => ({ from: (t: string) => chainFor(t) }),
  tenantRpc: vi.fn(async (_tid: string, name: string, args: unknown) => {
    h.rpcCalls.push({ name, args });
    if (name === "claim_news_digest_send") {
      return h.claimError
        ? { data: null, error: h.claimError }
        : { data: [{ id: "delivery-1", is_fresh: h.claimFresh }], error: null };
    }
    return { data: null, error: null };
  }),
}));

import { sendTenantDigest } from "../digest";

const TENANT = { id: "22222222-2222-4222-8222-222222222222", display_name: "UpcarAI" };
const FINDING = { id: "f1", headline: "Turo raises prices", why: "competitor", normalized_url: "https://x/y", score: 0.9 };

beforeEach(() => {
  h.pendingRows = [];
  h.claimError = null;
  h.claimFresh = true;
  h.emailOutcome = { sent: true, count: 1 };
  h.rpcCalls = [];
  h.updateCalls = 0;
});

describe("sendTenantDigest — fire-on-break", () => {
  it("EMPTY findings → no claim, no email", async () => {
    h.pendingRows = [];
    const out = await sendTenantDigest(TENANT);
    expect(out.status).toBe("skipped");
    expect(out).toMatchObject({ reason: "no_fresh_findings" });
    expect(h.rpcCalls.find((c) => c.name === "claim_news_digest_send")).toBeUndefined();
  });

  it("COOLDOWN active → skipped, no email, no stamp", async () => {
    h.pendingRows = [FINDING];
    h.claimError = { message: "cooldown" };
    const out = await sendTenantDigest(TENANT);
    expect(out.status).toBe("skipped");
    expect(out).toMatchObject({ reason: "cooldown" });
    expect(h.updateCalls).toBe(0);
    expect(h.rpcCalls.some((c) => c.name === "mark_news_digest_sent")).toBe(false);
  });

  it("SENT → atomically marks 'sent' + stamps the flushed finding ids in the RPC", async () => {
    h.pendingRows = [FINDING];
    const out = await sendTenantDigest(TENANT);
    expect(out.status).toBe("sent");
    expect(h.rpcCalls).toContainEqual({
      name: "mark_news_digest_sent",
      args: { p_id: "delivery-1", p_status: "sent", p_finding_ids: ["f1"] },
    });
    expect(h.updateCalls).toBe(0);
  });

  it("RE-CLAIM (is_fresh=false) → at-most-once: skip, no email, no stamp", async () => {
    h.pendingRows = [FINDING];
    h.claimFresh = false;
    const out = await sendTenantDigest(TENANT);
    expect(out.status).toBe("skipped");
    expect(out).toMatchObject({ reason: "reclaim_in_flight" });
    expect(h.updateCalls).toBe(0);
    expect(h.rpcCalls.some((c) => c.name === "mark_news_digest_sent")).toBe(false);
  });

  it("SEND FAILED → marks 'failed' (no cooldown start), findings NOT stamped", async () => {
    h.pendingRows = [FINDING];
    h.emailOutcome = { sent: false, reason: "no_recipients" };
    const out = await sendTenantDigest(TENANT);
    expect(out.status).toBe("skipped");
    expect(h.rpcCalls).toContainEqual({ name: "mark_news_digest_sent", args: { p_id: "delivery-1", p_status: "failed" } });
    expect(h.updateCalls).toBe(0);
  });
});
