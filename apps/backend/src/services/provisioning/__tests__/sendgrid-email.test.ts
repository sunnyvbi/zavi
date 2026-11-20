import { describe, it, expect } from "vitest";
import { createSendgridEmailProvisioner, emailSlug } from "@/services/provisioning/sendgrid-email";
import { tenantSuffix } from "@/services/provisioning/tenant-slug";

const T1 = tenantSuffix("t1");

describe("SendgridEmailProvisioner (shared-account model)", () => {
  it("missing both keys → CredentialNotConfigured(SYSTEM_SENDGRID_API_KEY)", async () => {
    const p = createSendgridEmailProvisioner({ token: () => null });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toMatchObject({
      key: "SYSTEM_SENDGRID_API_KEY",
    });
  });

  it("key present → per-company TENANT-SCOPED from-address on the shared domain, no Vault secret (A1)", async () => {
    const p = createSendgridEmailProvisioner({ token: () => "SG.key" });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme Corp!" });
    expect(r.external_ref).toEqual({
      from_address: `acme-corp-${T1}@zaviagent.com`,
      sender_domain: "zaviagent.com",
    });
    expect(r.vault_keys).toEqual({});
  });

  it("honors a custom sender domain", async () => {
    const p = createSendgridEmailProvisioner({ token: () => "SG.key", senderDomain: () => "mail.example.com" });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Beta" });
    expect(r.external_ref).toEqual({
      from_address: `beta-${T1}@mail.example.com`,
      sender_domain: "mail.example.com",
    });
  });

  it("teardown is a no-op (nothing created on SendGrid)", async () => {
    const p = createSendgridEmailProvisioner({ token: () => "SG.key" });
    await expect(p.teardown({})).resolves.toBeUndefined();
  });

  it("kind/provider = email/sendgrid", () => {
    const p = createSendgridEmailProvisioner({ token: () => "SG.key" });
    expect(p.kind).toBe("email");
    expect(p.provider).toBe("sendgrid");
  });

  it("emailSlug sanitizes + tenant-scopes (A1)", () => {
    expect(emailSlug("Acme Corp!", "t1")).toBe(`acme-corp-${T1}`);
    expect(emailSlug("", "t1")).toBe(`company-${T1}`);
    expect(emailSlug("UpcarAI", "tenant-a")).not.toBe(emailSlug("UpcarAI", "tenant-b"));
  });
});
