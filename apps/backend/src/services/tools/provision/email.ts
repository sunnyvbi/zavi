
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { shouldProvisionReal, slugify } from "./_provider";

const FLAG_ENV = "PROVISION_EMAIL";
const SENDGRID_API_KEY = "PROVISION_EMAIL_SENDGRID_API_KEY";
const SENDGRID_BASE_DEFAULT = "https://api.sendgrid.com/v3";

const TLD = "com";
const DEFAULT_SUBDOMAIN = "mail";

const inputSchema = z.object({
  company_name: z
    .string()
    .min(1)
    .max(100)
    .describe("The company name — used to derive the email domain."),
  domain: z
    .string()
    .min(3)
    .max(253)
    .optional()
    .describe("Optional explicit domain to authenticate. Defaults to <slug>.com derived from company_name."),
  dry_run: z
    .boolean()
    .default(true)
    .describe(
      "Default true (simulate). Pass false to attempt REAL SendGrid domain authentication — only succeeds when the PROVISION_EMAIL flag is on AND a SendGrid API key is set; otherwise falls back to dry-run.",
    ),
});

export type ProvisionEmailInput = z.infer<typeof inputSchema>;

export type ProvisionEmailDnsRecord = { type: string; host: string; data: string };

export type ProvisionEmailResult = {
  dry_run: boolean;
  created: boolean;
  domain: string;
  from_address: string;
  provider: string;
  domain_id: number | null;
  dns_records: ProvisionEmailDnsRecord[];
  reason: string;
  note: string;
};

export function deriveEmailDomain(company_name: string): string {
  return `${slugify(company_name)}.${TLD}`;
}

type SendGridDnsEntry = { host?: string; type?: string; data?: string };
type SendGridDomainResponse = {
  id?: number;
  dns?: Record<string, SendGridDnsEntry>;
  errors?: Array<{ message?: string }>;
};

async function authenticateDomain(
  domain: string,
  apiKey: string,
  baseUrl: string,
): Promise<{ domain_id: number; dns_records: ProvisionEmailDnsRecord[] }> {
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/whitelabel/domains`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ domain, subdomain: DEFAULT_SUBDOMAIN, automatic_security: true }),
    });
  } catch (e) {
    throw new ExpectedToolError(
      "email_provider_unreachable",
      `Could not reach SendGrid: ${(e as Error).message}`,
    );
  }

  let body: SendGridDomainResponse | null = null;
  try {
    body = (await resp.json()) as SendGridDomainResponse;
  } catch {
  }

  if (!resp.ok || !body || typeof body.id !== "number") {
    const message =
      body?.errors?.[0]?.message ?? `SendGrid returned HTTP ${resp.status}`;
    throw new ExpectedToolError("email_authentication_failed", message, {
      http_status: resp.status,
    });
  }

  const dns_records: ProvisionEmailDnsRecord[] = Object.values(body.dns ?? {})
    .filter((r): r is Required<SendGridDnsEntry> =>
      Boolean(r && r.host && r.type && r.data),
    )
    .map((r) => ({ type: r.type, host: r.host, data: r.data }));

  return { domain_id: body.id, dns_records };
}

export const provisionEmailTool: ToolSpec<ProvisionEmailInput, ProvisionEmailResult> = {
  name: "provision_email",
  effect: "write",
  description:
    "Set up transactional email (SendGrid domain authentication) for a new company. DRY-RUN by default — real setup only runs when the PROVISION_EMAIL flag is on AND a SendGrid API key is set AND dry_run:false; otherwise simulates.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown): Promise<ProvisionEmailResult> {
    const { company_name, domain: domainOverride, dry_run } = inputSchema.parse(input);
    const domain = domainOverride ?? deriveEmailDomain(company_name);
    const from_address = `hello@${domain}`;

    const gate = shouldProvisionReal({
      flagEnv: FLAG_ENV,
      requiredCreds: [SENDGRID_API_KEY],
      dryRunRequested: dry_run,
    });

    if (!gate.real) {
      const detail =
        gate.reason === "creds_missing"
          ? ` (SendGrid credentials not configured: ${gate.missingCreds.join(", ")})`
          : gate.reason === "flag_off"
            ? " (PROVISION_EMAIL flag is off)"
            : "";
      return {
        dry_run: true,
        created: false,
        domain,
        from_address,
        provider: "sendgrid",
        domain_id: null,
        dns_records: [],
        reason: gate.reason,
        note: `DRY-RUN: no real email domain was authenticated${detail}.`,
      };
    }

    const apiKey = process.env[SENDGRID_API_KEY] as string;
    const baseUrl = process.env.PROVISION_EMAIL_SENDGRID_BASE_URL || SENDGRID_BASE_DEFAULT;

    ctx.log("provision_email.authenticate.start", { domain });
    const { domain_id, dns_records } = await authenticateDomain(domain, apiKey, baseUrl);
    ctx.log("provision_email.authenticate.ok", { domain });

    return {
      dry_run: false,
      created: true,
      domain,
      from_address,
      provider: "sendgrid",
      domain_id,
      dns_records,
      reason: "ok",
      note: `Authenticated ${domain} on SendGrid. Publish the returned DNS records to verify.`,
    };
  },
};
