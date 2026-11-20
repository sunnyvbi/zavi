import { describe, it, expect, vi } from "vitest";
import { createStripeConnectProvisioner } from "@/services/provisioning/stripe-connect";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("StripeConnectProvisioner (double-gated E3)", () => {
  it("gate 1: missing STRIPE_PLATFORM_SECRET_KEY → CredentialNotConfigured", async () => {
    const p = createStripeConnectProvisioner({ isProd: () => true, token: () => null, enabled: () => true, fetchFn: vi.fn() as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toMatchObject({
      key: "STRIPE_PLATFORM_SECRET_KEY",
    });
  });

  it("gate 2: token present but E3 flag OFF → refuses (flags STRIPE_PROVISIONING_ENABLED), creates NOTHING", async () => {
    const fetchFn = vi.fn();
    const p = createStripeConnectProvisioner({ isProd: () => true, token: () => "sk_test", enabled: () => false, fetchFn: fetchFn as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toMatchObject({
      key: "STRIPE_PROVISIONING_ENABLED",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("off the prod backend a LIVE key is refused before any Stripe call (no real merchant from staging)", async () => {
    const fetchFn = vi.fn();
    const p = createStripeConnectProvisioner({ isProd: () => false, token: () => "sk_live_abc", enabled: () => true, fetchFn: fetchFn as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toBeInstanceOf(CredentialNotConfigured);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("off the prod backend a test-mode key still provisions", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, { id: "acct_t" }))
      .mockResolvedValueOnce(res(200, { url: "https://connect.stripe.com/setup/acct_t" }));
    const p = createStripeConnectProvisioner({ isProd: () => false, token: () => "sk_test_abc", enabled: () => true, fetchFn: fetchFn as never });
    expect((await p.ensure({ tenant_id: "t1", company_name: "Acme" })).external_ref.stripe_account_id).toBe("acct_t");
  });

  it("both gates open → creates a Standard account (Idempotency-Key) + onboarding link", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, { id: "acct_123" }))
      .mockResolvedValueOnce(res(200, { url: "https://connect.stripe.com/setup/acct_123" }));
    const p = createStripeConnectProvisioner({ isProd: () => true, token: () => "sk_test", enabled: () => true, fetchFn: fetchFn as never });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme" });
    expect(r.external_ref).toEqual({
      stripe_account_id: "acct_123",
      onboarding_url: "https://connect.stripe.com/setup/acct_123",
    });
    expect(r.vault_keys).toEqual({});
    expect(fetchFn.mock.calls[0][1]?.body).toContain("type=standard");
    expect(fetchFn.mock.calls[0][1]?.headers?.["Idempotency-Key"]).toBe("stripe-acct-t1");
  });

  it("teardown deletes the account", async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(200, {}));
    const p = createStripeConnectProvisioner({ isProd: () => true, token: () => "sk_test", enabled: () => true, fetchFn: fetchFn as never });
    await expect(p.teardown({ stripe_account_id: "acct_123" })).resolves.toBeUndefined();
    expect(fetchFn.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("kind/provider = stripe/stripe-connect", () => {
    const p = createStripeConnectProvisioner({ isProd: () => true, token: () => "sk", enabled: () => true });
    expect(p.kind).toBe("stripe");
    expect(p.provider).toBe("stripe-connect");
  });
});
