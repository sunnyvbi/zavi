
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { shouldProvisionReal, slugify } from "./_provider";

const FLAG_ENV = "PROVISION_DOMAIN";
const REGISTRAR_API_KEY = "PROVISION_DOMAIN_REGISTRAR_API_KEY";
const REGISTRAR_SECRET_KEY = "PROVISION_DOMAIN_REGISTRAR_SECRET_KEY";
const REGISTRAR_BASE_DEFAULT = "https://api.porkbun.com/api/json/v3";

const TLD = "com";

const inputSchema = z.object({
  company_name: z
    .string()
    .min(1)
    .max(100)
    .describe("The company name — used to derive the domain slug."),
  dry_run: z
    .boolean()
    .default(true)
    .describe(
      "Default true (simulate). Pass false to attempt REAL registration — only succeeds when the PROVISION_DOMAIN flag is on AND registrar creds are configured; otherwise falls back to dry-run.",
    ),
});

export type ProvisionDomainInput = z.infer<typeof inputSchema>;

export type ProvisionDomainResult = {
  dry_run: boolean;
  created: boolean;
  domain: string;
  registrar: string;
  reason: string;
  note: string;
};

export function deriveDomain(company_name: string): string {
  const slug = slugify(company_name);
  return `${slug}.${TLD}`;
}

async function registerWithRegistrar(
  domain: string,
  apiKey: string,
  secretKey: string,
  baseUrl: string,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/domain/create/${encodeURIComponent(domain)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: apiKey, secretapikey: secretKey, tld: TLD }),
    });
  } catch (e) {
    throw new ExpectedToolError(
      "domain_registrar_unreachable",
      `Could not reach the domain registrar: ${(e as Error).message}`,
    );
  }

  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
  }

  const status =
    body && typeof body === "object" && "status" in body
      ? String((body as { status: unknown }).status)
      : undefined;

  if (!resp.ok || status?.toUpperCase() !== "SUCCESS") {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : `registrar returned HTTP ${resp.status}`;
    throw new ExpectedToolError("domain_registration_failed", message, {
      http_status: resp.status,
      registrar_status: status,
    });
  }
}

export const provisionDomainTool: ToolSpec<ProvisionDomainInput, ProvisionDomainResult> = {
  name: "provision_domain",
  effect: "money",
  description:
    "Register a domain for a new company via the configured registrar API. DRY-RUN by default — real registration only runs when the PROVISION_DOMAIN flag is on AND registrar credentials are set AND dry_run:false; otherwise simulates.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown): Promise<ProvisionDomainResult> {
    const { company_name, dry_run } = inputSchema.parse(input);
    const domain = deriveDomain(company_name);

    const gate = shouldProvisionReal({
      flagEnv: FLAG_ENV,
      requiredCreds: [REGISTRAR_API_KEY, REGISTRAR_SECRET_KEY],
      dryRunRequested: dry_run,
    });

    if (!gate.real) {
      const detail =
        gate.reason === "creds_missing"
          ? ` (registrar credentials not configured: ${gate.missingCreds.join(", ")})`
          : gate.reason === "flag_off"
            ? " (PROVISION_DOMAIN flag is off)"
            : "";
      return {
        dry_run: true,
        created: false,
        domain,
        registrar: "porkbun",
        reason: gate.reason,
        note: `DRY-RUN: no real domain was registered${detail}.`,
      };
    }

    const apiKey = process.env[REGISTRAR_API_KEY] as string;
    const secretKey = process.env[REGISTRAR_SECRET_KEY] as string;
    const baseUrl = process.env.PROVISION_DOMAIN_REGISTRAR_BASE_URL || REGISTRAR_BASE_DEFAULT;

    ctx.log("provision_domain.register.start", { domain });
    await registerWithRegistrar(domain, apiKey, secretKey, baseUrl);
    ctx.log("provision_domain.register.ok", { domain });

    return {
      dry_run: false,
      created: true,
      domain,
      registrar: "porkbun",
      reason: "ok",
      note: `Registered ${domain} via the configured registrar.`,
    };
  },
};
