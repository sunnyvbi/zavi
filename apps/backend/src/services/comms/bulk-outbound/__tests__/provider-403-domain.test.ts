import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), row: null as null | Record<string, unknown> }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => mocks.rpc(...a),
  globalClient: () => ({ from: () => ({}) }),
  tenantClient: () => ({ from: () => ({ select: () => ({ maybeSingle: async () => ({ data: mocks.row, error: null }) }) }) }),
}));

import { markSendingDomainUnverified, PROVIDER_REFUSED_DOMAIN_ERROR } from "../sending-domain";
import { sendBulkTestEmail, TestSendError } from "@/services/email-cards/test-send";
import { emailCardHandlers } from "@/routes/email-cards";

const verified = { domain: "acme.com", from_address: "hi@acme.com", from_name: "Acme", verification_status: "verified", verification_error: null, dns_records: [], provider_domain_id: "77", verified_at: "2026-10-01T00:00:00Z" };
const saved = process.env.BULK_SENDGRID_API_KEY;

beforeEach(() => {
  mocks.rpc.mockReset().mockResolvedValue({ data: true, error: null });
  mocks.row = { ...verified };
  process.env.BULK_SENDGRID_API_KEY = "bulk-key";
});
afterEach(() => {
  if (saved === undefined) delete process.env.BULK_SENDGRID_API_KEY;
  else process.env.BULK_SENDGRID_API_KEY = saved;
});

describe("the provider refuses mail From a domain Zavi thinks is verified", () => {
  it("re-checked with the provider and not valid: the domain is marked failed with the reason", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ valid: false, validation_results: { mail_cname: { valid: false, reason: "Expected CNAME for em1.acme.com to match u1.wl.sendgrid.net" } } }) }));
    expect(await markSendingDomainUnverified("t", { fetch })).toBe("failed");
    expect((fetch.mock.calls[0] as unknown[])[0]).toMatch(/\/whitelabel\/domains\/77\/validate$/);
    expect(mocks.rpc).toHaveBeenCalledWith("t", "tenant_sending_domain_set_status", { p_provider_domain_id: "77", p_domain: "acme.com", p_status: "failed", p_error: PROVIDER_REFUSED_DOMAIN_ERROR });
  });

  it("the re-check says it is still valid: the status is left alone", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ valid: true }) }));
    expect(await markSendingDomainUnverified("t", { fetch })).toBe("verified");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("the re-check call fails: the status is left alone", async () => {
    for (const fetch of [vi.fn(async () => { throw new Error("net"); }), vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))]) {
      expect(await markSendingDomainUnverified("t", { fetch: fetch as never })).toBeNull();
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("a Zavi-list test send the provider refuses", () => {
  const v = { n: 1, subject: "S", preview_text: null, html: "<p>x {{zavi_unsubscribe_url}}</p>", text: "x {{zavi_unsubscribe_url}}", render_sha: "a".repeat(64) };
  const deps = (status: number, recheck = vi.fn(async () => "failed")) => ({
    checkSender: (async () => ({ ok: true, sender: { domain: "acme.com", from_address: "hi@acme.com", from_name: "Acme" } })) as never,
    bulkKey: () => "bulk-key",
    fetch: (async () => new Response("{\"errors\":[{\"message\":\"The from address does not match a verified Sender Identity: hi@acme.com\"}]}", { status })) as never,
    recheckDomain: recheck,
    replyTo: async () => null,
  });

  it("403: a definite, readable refusal, and the domain is re-checked", async () => {
    const recheck = vi.fn(async () => "failed");
    const err = await sendBulkTestEmail("t", { from_address: "hi@acme.com" }, v, "owner@acme.com", deps(403, recheck)).catch((e) => e);
    expect(err).toBeInstanceOf(TestSendError);
    expect(err).toMatchObject({ code: "sending_address_not_verified", message: "Your sending address isn't verified with the email provider any more. Re-check the sending domain in Settings. Nothing was sent." });
    expect(err.message).not.toContain("hi@acme.com");
    expect(recheck).toHaveBeenCalledWith("t");
  });

  it("another 4xx is provider_refused; a 5xx is provider_unavailable; neither re-checks the domain", async () => {
    const recheck = vi.fn(async () => "failed");
    await expect(sendBulkTestEmail("t", { from_address: "hi@acme.com" }, v, "o@acme.com", deps(400, recheck))).rejects.toMatchObject({ code: "provider_refused", status: 400 });
    await expect(sendBulkTestEmail("t", { from_address: "hi@acme.com" }, v, "o@acme.com", deps(503, recheck))).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(recheck).not.toHaveBeenCalled();
  });

  it("the test route answers a definite refusal with 422, never a 5xx", async () => {
    const authMod = await import("@/services/auth/middleware");
    vi.spyOn(authMod, "requireAuth").mockResolvedValue({ tenant_id: "t", user_id: "u" } as never);
    for (const [code, status] of [["sending_address_not_verified", 422], ["provider_refused", 422], ["provider_unavailable", 502]] as const) {
      const h = emailCardHandlers({
        rpc: (async (_t: string, name: string) =>
          name === "email_card_for_test" ? { ok: false, code, message: "m" } : { ok: true }) as never,
      });
      const r = { statusCode: 200, body: undefined as any, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
      await h.test({ params: { rail: "decisions", id: "22222222-2222-4222-8222-222222222222" }, body: { variant: 1 } } as never, r as never);
      expect([r.statusCode, r.body.error.code]).toEqual([status, code]);
    }
  });
});
