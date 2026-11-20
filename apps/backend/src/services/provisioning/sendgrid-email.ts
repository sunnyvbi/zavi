
import type { EnsureInput, Provisioner, ProvisionResult } from "./types";
import { CredentialNotConfigured } from "./github-repo";
import { tenantScopedSlug } from "./tenant-slug";

type SendgridDeps = {
  token?: () => string | null;
  senderDomain?: () => string;
};

export function emailSlug(company_name: string, tenant_id: string): string {
  return tenantScopedSlug(company_name, tenant_id, 51);
}

export function createSendgridEmailProvisioner(deps: SendgridDeps = {}): Provisioner {
  const getToken =
    deps.token ??
    (() => process.env.SENDGRID_PROVISION_KEY ?? process.env.SYSTEM_SENDGRID_API_KEY ?? null);
  const getSenderDomain = deps.senderDomain ?? (() => process.env.SENDGRID_SENDER_DOMAIN ?? "zaviagent.com");

  async function ensure(input: EnsureInput): Promise<ProvisionResult> {
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("SYSTEM_SENDGRID_API_KEY");
    const slug = emailSlug(input.company_name, input.tenant_id);
    const sender_domain = getSenderDomain();
    return {
      external_ref: { from_address: `${slug}@${sender_domain}`, sender_domain },
      vault_keys: {},
    };
  }

  async function teardown(): Promise<void> {
  }

  return { kind: "email", provider: "sendgrid", ensure, teardown };
}
