
import { listAgents, loadAgentDefinition } from "@/services/agents/registry";
import { listTools } from "@/services/tools/registry";
import { PRICING } from "@/services/anthropic";
import { getSecret } from "@/services/secrets/vault";
import { serviceClient } from "@/services/supabase";
import { isOwnExternalSite, linkedWithAliases, satisfyingSlugs } from "@zavi/shared";
import { zaviBuiltRepoForRun } from "./zavi-built-repo";

export type VaultKeySchema = {
  key: string;
  label: string;
  input: "text" | "email" | "password" | "url";
  required: boolean;
  placeholder?: string;
};

export type AgentSetupSchema = {
  rationale: string;
  vault_keys: VaultKeySchema[];
  connectors: string[];
  optional_connectors: string[];
};

export type SetupProbeResult = {
  ok: boolean;
  missing_vault_keys: string[];
  missing_connectors: string[];
  missing_required_connectors: string[];
  missing_optional_connectors: string[];
};

export const TOOL_PREFIX_TO_CONNECTOR: Record<string, string> = {
  slack: "slack",
  github: "github",
  jira: "jira",
  linear: "linear",
  stripe: "stripe",
  email: "email",
  linkedin_social: "linkedin_social",
  x_social: "x_social",
  reddit_social: "reddit_social",
  instagram_social: "instagram_social",
  instagram: "composio.instagram",
  youtube_insights: "composio.youtube",
  pinterest_insights: "composio.pinterest",
  gmail: "composio.gmail",
  mailchimp: "composio.mailchimp",
  klaviyo: "composio.klaviyo",
  higgsfield: "higgsfield",
  google_ads: "google_ads",
  google_analytics: "google_analytics",
  google_search_console: "google_search_console",
  posthog: "posthog",
  sentry: "sentry",
  figma: "figma",
  google_calendar: "google_calendar",
  google_sheets: "google_sheets",
  supabase: "supabase",
  meta_ads: "meta_ads",
  operator_db: "operator_db",
  tiktok: "tiktok",
  reddit_ads: "reddit_ads",
  tiktok_ads: "tiktok_ads",
  linkedin_ads: "linkedin_ads",
  snapchat_ads: "snapchat_ads",
  spotify_ads: "spotify_ads",
  pinterest_ads: "pinterest_ads",
  microsoft_ads: "microsoft_ads",
  x_ads: "x_ads",
  apple_ads: "apple_ads",
};

function deriveConnectorsFromTools(tools: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const t of tools) {
    const idx = t.indexOf("__");
    if (idx <= 0) continue;
    const prefix = t.slice(0, idx);
    const connector = TOOL_PREFIX_TO_CONNECTOR[prefix];
    if (connector) seen.add(connector);
  }
  return [...seen].sort();
}

export async function getAgentSetupSchema(
  slug: string,
  tenant_id: string,
): Promise<AgentSetupSchema | null> {
  const agent = await loadAgentDefinition(slug, tenant_id);
  if (!agent) return null;
  const meta = agent.metadata_praxis;
  const tools = meta.tools ?? [];
  const derived = deriveConnectorsFromTools(tools);
  const explicit = meta.setup?.connectors ?? [];
  const explicitOptional = meta.setup?.optional_connectors ?? [];
  const connectors = [...new Set([...derived, ...explicit, ...explicitOptional])].sort();
  const optionalSet = new Set(explicitOptional);
  const optional_connectors = connectors.filter((c) => optionalSet.has(c));
  return {
    rationale: meta.setup?.rationale ?? "",
    vault_keys: (meta.setup?.vault_keys ?? []) as VaultKeySchema[],
    connectors,
    optional_connectors,
  };
}

export async function probeSetupCompleteness(
  tenant_id: string,
  slug: string,
): Promise<SetupProbeResult> {
  const schema = await getAgentSetupSchema(slug, tenant_id);
  if (!schema) {
    return {
      ok: true,
      missing_vault_keys: [],
      missing_connectors: [],
      missing_required_connectors: [],
      missing_optional_connectors: [],
    };
  }
  const optionalSet = new Set(schema.optional_connectors);
  const missingVault: string[] = [];
  for (const v of schema.vault_keys) {
    if (!v.required) continue;
    try {
      const value = await getSecret(tenant_id, v.key);
      if (!value) missingVault.push(v.key);
    } catch {
      missingVault.push(v.key);
    }
  }
  const missingConnectors: string[] = [];
  if (schema.connectors.length > 0) {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("connector_metadata")
      .select("slug")
      .eq("tenant_id", tenant_id)
      .in("slug", [...new Set(schema.connectors.flatMap((c) => satisfyingSlugs(c)))]);
    if (error) {
      const missingRequired = schema.connectors.filter(
        (c) => !optionalSet.has(c),
      );
      const missingOptional = schema.connectors.filter((c) => optionalSet.has(c));
      return {
        ok: false,
        missing_vault_keys: missingVault,
        missing_connectors: schema.connectors,
        missing_required_connectors: missingRequired,
        missing_optional_connectors: missingOptional,
      };
    }
    const connected = linkedWithAliases(
      (data ?? []).map((r) => (r as { slug: string }).slug),
    );
    for (const c of schema.connectors) {
      if (!connected.has(c)) missingConnectors.push(c);
    }
  }
  const missingRequiredConnectors = missingConnectors.filter(
    (c) => !optionalSet.has(c),
  );
  const missingOptionalConnectors = missingConnectors.filter((c) =>
    optionalSet.has(c),
  );
  return {
    ok:
      missingVault.length === 0 && missingRequiredConnectors.length === 0,
    missing_vault_keys: missingVault,
    missing_connectors: missingConnectors,
    missing_required_connectors: missingRequiredConnectors,
    missing_optional_connectors: missingOptionalConnectors,
  };
}

const UMBRELLA_CONNECTOR_ACCOUNT_LOGIN = "Praxis-build";

export const isOwnSiteUrl = isOwnExternalSite;

export function hasOwnGithubRow(rows: ReadonlyArray<{ slug?: unknown; account_login?: unknown }>): boolean {
  return rows.some(
    (r) =>
      r.slug === "github" &&
      (typeof r.account_login === "string" ? r.account_login : "") !== UMBRELLA_CONNECTOR_ACCOUNT_LOGIN,
  );
}

export async function firstMissingChatConnector(
  tenant_id: string,
  slug: string,
  probe: SetupProbeResult,
  repo_hint?: string | null,
): Promise<string | null> {
  const others = probe.missing_required_connectors.filter((c) => c !== "github");
  try {
    if (await zaviBuiltRepoForRun(tenant_id, repo_hint)) return others[0] ?? null;
    const schema = await getAgentSetupSchema(slug, tenant_id);
    const requiresGithub =
      !!schema && schema.connectors.includes("github") && !schema.optional_connectors.includes("github");
    if (requiresGithub) {
      const sb = serviceClient();
      const [tenantRes, rowsRes] = await Promise.all([
        sb.from("tenants").select("product_url").eq("id", tenant_id).maybeSingle(),
        sb
          .from("connector_metadata")
          .select("slug, account_login")
          .eq("tenant_id", tenant_id)
          .eq("slug", "github"),
      ]);
      if (tenantRes.error || rowsRes.error) return null;
      const productUrl = (tenantRes.data as { product_url?: unknown } | null)?.product_url;
      const marketing =
        productUrl && typeof productUrl === "object"
          ? (productUrl as { marketing?: unknown }).marketing
          : undefined;
      if (
        isOwnSiteUrl(marketing) &&
        !hasOwnGithubRow((rowsRes.data ?? []) as Array<{ slug?: unknown; account_login?: unknown }>)
      ) {
        return "github";
      }
    }
  } catch {
    return null;
  }
  return others[0] ?? null;
}

export async function recordSetupBlock(
  tenant_id: string,
  slug: string,
  probe: SetupProbeResult,
  blocked_run_id: string,
): Promise<void> {
  const sb = serviceClient();
  if (probe.ok) {
    await sb
      .from("agent_setup_state")
      .delete()
      .eq("tenant_id", tenant_id)
      .eq("agent_slug", slug);
    return;
  }
  await sb.from("agent_setup_state").upsert(
    {
      tenant_id,
      agent_slug: slug,
      last_blocked_at: new Date().toISOString(),
      missing_vault_keys: probe.missing_vault_keys,
      missing_connectors: probe.missing_connectors,
      blocked_run_id,
    },
    { onConflict: "tenant_id,agent_slug" },
  );
}

export const LOCKED_FRONTMATTER_KEYS = [
  "decision_class",
  "side_effects",
  "requires_sandbox",
  "runtime",
  "kill_switch",
  "impact_classes",
] as const;

export const EDITABLE_FRONTMATTER_KEYS = [
  "model",
  "tools",
  "output_envelope",
  "cron",
  "triggers",
  "response_contract",
  "recall_policy",
  "cost_class",
  "sla_class",
  "tool_iter_cap",
  "manual_only",
  "prose_fallback",
  "memory_layer",
  "inherits",
] as const;

const COST_CLASSES = new Set(["cheap", "standard", "expensive"]);
const SLA_CLASSES = new Set(["realtime", "hourly", "prompt", "daily", "weekly", "bulk"]);
const RESPONSE_CONTRACTS = new Set(["auto", "digest", "terse"]);
const RECALL_POLICIES = new Set(["always", "live_state_aware"]);

export const ALLOWED_MODELS: readonly string[] = Object.freeze(Object.keys(PRICING));

let _toolUniverse: string[] | null = null;
export function listFleetToolUniverse(): string[] {
  if (_toolUniverse) return _toolUniverse;
  const seen = new Set<string>();
  for (const a of listAgents()) {
    for (const t of a.metadata_praxis.tools ?? []) seen.add(t);
  }
  for (const spec of listTools()) seen.add(spec.name);
  _toolUniverse = [...seen].sort();
  return _toolUniverse;
}

const COUPLED_ENVELOPES = new Set<string>([
  "pr_proposal",
  "product_pm_backlog",
  "research_report",
  "competitor_brief",
  "supply_demand_brief",
  "advice",
  "application_finalized",
  "coach",
]);

export class FrontmatterValidationError extends Error {
  code: "locked_field" | "unknown_field" | "invalid_value" | "envelope_coupled";
  field: string;
  constructor(
    code: FrontmatterValidationError["code"],
    field: string,
    message: string,
  ) {
    super(message);
    this.name = "FrontmatterValidationError";
    this.code = code;
    this.field = field;
  }
}

type Frontmatter = Record<string, unknown>;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function getMetaPraxis(fm: Frontmatter): Frontmatter {
  const meta = (fm?.metadata as Frontmatter | undefined) ?? {};
  return (meta.praxis as Frontmatter | undefined) ?? {};
}

export function mergeEditableFrontmatter(
  base: Frontmatter,
  submitted: Frontmatter,
): Frontmatter {
  const editable = new Set<string>(EDITABLE_FRONTMATTER_KEYS);
  const locked = new Set<string>(LOCKED_FRONTMATTER_KEYS);

  const basePraxis = getMetaPraxis(base);
  const submittedPraxis = getMetaPraxis(submitted);

  const outPraxis: Frontmatter = JSON.parse(JSON.stringify(basePraxis ?? {}));

  for (const [key, value] of Object.entries(submittedPraxis ?? {})) {
    if (key === "setup") {
      if (!sameValue(value, basePraxis?.setup)) {
        throw new FrontmatterValidationError(
          "locked_field",
          "setup",
          "setup (credentials/connectors) is server-managed and cannot be edited via this form.",
        );
      }
      continue;
    }
    if (locked.has(key)) {
      if (!sameValue(value, basePraxis?.[key])) {
        throw new FrontmatterValidationError(
          "locked_field",
          key,
          `Field "${key}" is locked (money/safety path) and cannot be changed via this editor.`,
        );
      }
      continue;
    }
    if (!editable.has(key)) {
      if (!sameValue(value, basePraxis?.[key])) {
        throw new FrontmatterValidationError(
          "unknown_field",
          key,
          `Field "${key}" is not editable.`,
        );
      }
      continue;
    }
    validateEditableValue(key, value, basePraxis);
    outPraxis[key] = value;
  }

  const finalTools = isStringArray(outPraxis.tools) ? outPraxis.tools : [];
  const baseSetup = (basePraxis?.setup ?? {}) as Record<string, unknown>;
  const explicit = isStringArray(baseSetup.connectors) ? baseSetup.connectors : [];
  const derived = deriveConnectorsFromTools(finalTools);
  const connectors = [...new Set([...derived, ...explicit.filter((c) => !derived.includes(c))])].sort();
  const hasSetup =
    (baseSetup.rationale && String(baseSetup.rationale).length > 0) ||
    (Array.isArray(baseSetup.vault_keys) && baseSetup.vault_keys.length > 0) ||
    connectors.length > 0 ||
    (isStringArray(baseSetup.optional_connectors) ? baseSetup.optional_connectors.length > 0 : false);
  if (hasSetup) {
    outPraxis.setup = {
      ...baseSetup,
      connectors,
    };
  }

  const out: Frontmatter = JSON.parse(JSON.stringify(base ?? {}));
  const meta = (out.metadata as Frontmatter | undefined) ?? {};
  out.metadata = { ...meta, praxis: outPraxis };
  return out;
}

function validateEditableValue(key: string, value: unknown, base: Frontmatter): void {
  switch (key) {
    case "model":
      if (typeof value !== "string" || !ALLOWED_MODELS.includes(value)) {
        throw new FrontmatterValidationError(
          "invalid_value",
          key,
          `model must be one of: ${ALLOWED_MODELS.join(", ")}.`,
        );
      }
      return;
    case "tools": {
      if (!isStringArray(value)) {
        throw new FrontmatterValidationError("invalid_value", key, "tools must be an array of tool slugs.");
      }
      const universe = new Set(listFleetToolUniverse());
      for (const t of value) {
        if (!universe.has(t)) {
          throw new FrontmatterValidationError(
            "invalid_value",
            key,
            `Unknown tool "${t}" — not in the fleet tool registry.`,
          );
        }
      }
      return;
    }
    case "output_envelope": {
      if (value !== undefined && typeof value !== "string") {
        throw new FrontmatterValidationError("invalid_value", key, "output_envelope must be a string.");
      }
      const current = typeof base?.output_envelope === "string" ? base.output_envelope : undefined;
      if (current && COUPLED_ENVELOPES.has(current) && value !== current) {
        throw new FrontmatterValidationError(
          "envelope_coupled",
          key,
          `output_envelope "${current}" drives a downstream pipeline and cannot be changed here.`,
        );
      }
      return;
    }
    case "cron":
      if (value !== undefined && typeof value !== "string") {
        throw new FrontmatterValidationError("invalid_value", key, "cron must be a string.");
      }
      return;
    case "triggers":
    case "inherits":
      if (!isStringArray(value)) {
        throw new FrontmatterValidationError("invalid_value", key, `${key} must be an array of strings.`);
      }
      return;
    case "response_contract":
      if (typeof value !== "string" || !RESPONSE_CONTRACTS.has(value)) {
        throw new FrontmatterValidationError("invalid_value", key, "response_contract must be auto|digest|terse.");
      }
      return;
    case "recall_policy":
      if (typeof value !== "string" || !RECALL_POLICIES.has(value)) {
        throw new FrontmatterValidationError("invalid_value", key, "recall_policy must be always|live_state_aware.");
      }
      return;
    case "cost_class":
      if (typeof value !== "string" || !COST_CLASSES.has(value)) {
        throw new FrontmatterValidationError("invalid_value", key, "cost_class must be cheap|standard|expensive.");
      }
      return;
    case "sla_class":
      if (value !== undefined && (typeof value !== "string" || !SLA_CLASSES.has(value))) {
        throw new FrontmatterValidationError("invalid_value", key, "sla_class is not a recognized value.");
      }
      return;
    case "tool_iter_cap":
      if (
        value !== undefined &&
        (typeof value !== "number" || !Number.isInteger(value) || value < 10 || value > 120)
      ) {
        throw new FrontmatterValidationError("invalid_value", key, "tool_iter_cap must be an integer 10–120.");
      }
      return;
    case "manual_only":
    case "prose_fallback":
    case "memory_layer":
      if (typeof value !== "boolean") {
        throw new FrontmatterValidationError("invalid_value", key, `${key} must be a boolean.`);
      }
      return;
    default:
      throw new FrontmatterValidationError("unknown_field", key, `Field "${key}" is not editable.`);
  }
}
