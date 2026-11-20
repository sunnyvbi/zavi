
import type { ToolEffect } from "@/services/tools/types";
import { z } from "zod";
import type { McpCallResult, McpTool } from "../types";
import { zodToJsonSchema } from "@/services/tools/registry";
import { serviceClient } from "@/services/supabase";
import { zaviBuiltRepoForRun } from "@/services/agents/zavi-built-repo";
import { listComposioCatalog } from "@/services/connectors/composio/catalog";
import { NATIVE_ONLY_TOOLKITS, TILE_TOOLKITS } from "@/services/connectors/composio/native-map";
import {
  CONNECTOR_CONNECT,
  NATIVE_DESCRIPTOR_TO_COMPOSIO,
  PIPEDREAM_PREFIX,
  connectInfoFor,
  railFor,
  isOwnExternalSite,
  rowSatisfiesConnectorRequest,
  satisfyingSlugs,
} from "@zavi/shared";
import { isConnectorRequestEnabled } from "@/services/agents/_chat-degrade-flag-check";

const searchInput = z.object({
  query: z.string().min(1).max(120),
  max_results: z.number().int().min(1).max(25).default(10),
});

const requestInput = z.object({
  slug: z.string().min(1).max(80),
  reason: z.string().max(500).default(""),
});

type SpecEntry = { description: string; schema: z.ZodTypeAny; effect: ToolEffect };

const SPECS: Record<string, SpecEntry> = {
  request: {
    description:
      "Ask the user to connect a service this request needs (live data or an action) that isn't connected. Shows them a Connect button. `slug` is a connector slug (e.g. meta_ads, github, google_analytics) or a `composio.<app>` slug from connectors__search; `reason` is one short sentence on what you need it for. Do not call it for questions you can answer without live data.",
    schema: requestInput,
    effect: "write",
  },
  search: {
    description:
      "Search the connector catalog (connected-app catalog) for an app/integration by name and find out whether THIS tenant has it connected. Use this INSTEAD of guessing connector state from memory: when a user asks about a connector that is not in your CONNECTED CONNECTORS list, call this to confirm whether it exists and is already connected before you answer or offer to connect it. Read-only. Returns matches with a canonical slug, display name, provider (native/composio), and an `already_connected` flag.",
    schema: searchInput,
    effect: "read",
  },
};

export function listConnectorSearchTools(): McpTool[] {
  return Object.entries(SPECS).map(([tool_name, spec]) => {
    const schema = zodToJsonSchema(spec.schema);
    if (schema.type !== "object") {
      throw new Error(`connectors/${tool_name} input schema must be a top-level z.object()`);
    }
    return {
      server_id: "connectors",
      tool_name,
      description: spec.description,
      effect: spec.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

type Candidate = {
  slug: string;
  name: string;
  provider: "native" | "composio";
  already_connected: boolean;
};

async function connectedSlugSet(tenant_id: string): Promise<Set<string>> {
  try {
    const { data, error } = await serviceClient()
      .from("connector_metadata")
      .select("slug")
      .eq("tenant_id", tenant_id);
    if (error) {
      console.warn(
        `[connectors-search] connector_metadata read failed for tenant=${tenant_id}: ${error.message}`,
      );
      return new Set();
    }
    return new Set(
      (data ?? [])
        .map((r) => r.slug as unknown)
        .filter((s): s is string => typeof s === "string" && s.length > 0),
    );
  } catch (e) {
    console.warn(
      `[connectors-search] connector_metadata exception for tenant=${tenant_id}: ${(e as Error).message}`,
    );
    return new Set();
  }
}

export async function callConnectorSearchTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
  run_id?: string,
): Promise<McpCallResult> {
  const start = Date.now();
  const spec = SPECS[tool_name];
  if (!spec) {
    return errorResult(start, "tool_unknown", `connectors/${tool_name} not registered`);
  }
  if (tool_name === "request") return callConnectorRequestTool(tenant_id, args, start, run_id);
  let parsed: z.infer<typeof searchInput>;
  try {
    parsed = spec.schema.parse(args) as z.infer<typeof searchInput>;
  } catch (e) {
    if ((e as { name?: string })?.name === "ZodError") {
      return errorResult(start, "tool_input_invalid", (e as Error).message);
    }
    throw e;
  }

  const q = parsed.query.trim();
  const qLower = q.toLowerCase();
  const connected = await connectedSlugSet(tenant_id);

  const isConnected = (slug: string) => satisfyingSlugs(slug).some((x) => connected.has(x));
  const hit = (slug: string, name: string) =>
    slug.toLowerCase().includes(qLower) || name.toLowerCase().includes(qLower);

  const native: Candidate[] = [];
  for (const [slug, info] of Object.entries(CONNECTOR_CONNECT)) {
    if ((NATIVE_DESCRIPTOR_TO_COMPOSIO[slug] ?? []).some((k) => railFor(k) === "composio" && `composio.${k}` in CONNECTOR_CONNECT)) continue;
    if (!hit(slug, info.label)) continue;
    native.push({ slug, name: info.label, provider: slug.startsWith("composio.") ? "composio" : "native", already_connected: isConnected(slug) });
  }

  let composio: Candidate[] = [];
  try {
    composio = (await listComposioCatalog())
      .filter((t) => !NATIVE_ONLY_TOOLKITS.has(t.slug) && !TILE_TOOLKITS.has(t.slug) && railFor(t.slug) === "composio")
      .filter((t) => hit(t.slug, t.name))
      .map((t) => ({ slug: `composio.${t.slug}`, name: t.name, provider: "composio" as const, already_connected: connected.has(`composio.${t.slug}`) }));
  } catch (e) {
    console.warn(`[connectors-search] composio catalog read failed: ${(e as Error).message}`);
  }

  const byName = new Map<string, Candidate>();
  for (const c of [...native, ...composio]) {
    const key = c.name.toLowerCase();
    const prev = byName.get(key);
    if (!prev || (c.already_connected && !prev.already_connected)) byName.set(key, c);
  }

  const exact = (c: Candidate) =>
    c.name.toLowerCase() === qLower || c.slug.slice(c.slug.indexOf(".") + 1) === qLower.replace(/[\s-]+/g, "_");
  const matches = Array.from(byName.values())
    .sort((a, b) => {
      if (a.already_connected !== b.already_connected) return a.already_connected ? -1 : 1;
      if (exact(a) !== exact(b)) return exact(a) ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, parsed.max_results);

  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      query: q,
      match_count: matches.length,
      matches,
      note:
        matches.length === 0
          ? "No connector in the catalog matched. Tell the user you couldn't find a matching connector rather than guessing."
          : "An `already_connected: true` match means this tenant has that connector set up right now — do NOT tell the user it isn't connected.",
    }),
    ms: Date.now() - start,
  };
}

function errorResult(start: number, code: string, message: string): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({ error: code, message }),
    ms: Date.now() - start,
  };
}

export type ConnectorRequestValidation =
  | { ok: true; slug: string; label: string }
  | {
      ok: false;
      error:
        | "unknown_connector"
        | "already_connected"
        | "connector_catalog_unavailable"
        | "connector_request_disabled";
      message: string;
    };

export async function validateConnectorRequest(
  tenant_id: string,
  rawSlug: string,
  opts: { repo_hint?: string | null } = {},
): Promise<ConnectorRequestValidation> {
  if (!(await isConnectorRequestEnabled())) {
    return {
      ok: false,
      error: "connector_request_disabled",
      message: "Connect cards are off. Answer normally and name the service to connect in Settings.",
    };
  }
  const slug = rawSlug.trim();
  const unknown: ConnectorRequestValidation = {
    ok: false,
    error: "unknown_connector",
    message: `No connector "${slug.slice(0, 80)}". Use connectors__search to find the right slug.`,
  };
  if (slug.startsWith(PIPEDREAM_PREFIX)) return unknown;
  const info = connectInfoFor(slug);
  if (!info) return unknown;

  if (slug === "github") {
    const zaviRepo = await zaviBuiltRepoForRun(tenant_id, opts.repo_hint);
    if (zaviRepo) {
      return {
        ok: false,
        error: "already_connected",
        message: `GitHub is already connected for this chat: the code is in ${zaviRepo}, the site Zavi built for this user. Work on that repo with your tools. Do not ask the user to connect GitHub or whether they have an existing codebase.`,
      };
    }
  }
  const { data, error } = await serviceClient()
    .from("connector_metadata")
    .select("slug, account_login")
    .eq("tenant_id", tenant_id)
    .in("slug", satisfyingSlugs(slug));
  if (error) {
    return {
      ok: false,
      error: "connector_catalog_unavailable",
      message: "Connection state can't be checked right now. Tell the user you can't check that service right now.",
    };
  }
  const rows = (data ?? []) as Array<{ slug: string; account_login?: string | null }>;
  if (
    rows.some((r) => rowSatisfiesConnectorRequest(r, slug)) ||
    (slug === "github" && rows.length > 0 && !(await tenantRunsOwnSite(tenant_id)))
  ) {
    return {
      ok: false,
      error: "already_connected",
      message: `${info.label} is already connected. Use its tools; if a call fails, report the actual error.`,
    };
  }
  return { ok: true, slug, label: info.label };
}

const recordedByRun = new Map<string, { slug: string; label: string; reason: string }>();
const RECORDED_MAX = 500;

export function takeRecordedConnectorRequest(
  run_id: string,
): { slug: string; label: string; reason: string } | null {
  const hit = recordedByRun.get(run_id) ?? null;
  recordedByRun.delete(run_id);
  return hit;
}

async function tenantRunsOwnSite(tenant_id: string): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from("tenants")
    .select("product_url")
    .eq("id", tenant_id)
    .maybeSingle();
  if (error) return true;
  const pu = (data as { product_url?: unknown } | null)?.product_url;
  return isOwnExternalSite(pu && typeof pu === "object" ? (pu as { marketing?: unknown }).marketing : undefined);
}

async function callConnectorRequestTool(
  tenant_id: string,
  args: unknown,
  start: number,
  run_id?: string,
): Promise<McpCallResult> {
  const parsed = requestInput.safeParse(args);
  if (!parsed.success) return errorResult(start, "tool_input_invalid", parsed.error.message);
  const v = await validateConnectorRequest(tenant_id, parsed.data.slug);
  if (!v.ok) return errorResult(start, v.error, v.message);
  if (run_id) {
    if (recordedByRun.size >= RECORDED_MAX) {
      const oldest = recordedByRun.keys().next().value;
      if (oldest !== undefined) recordedByRun.delete(oldest);
    }
    recordedByRun.set(run_id, { slug: v.slug, label: v.label, reason: parsed.data.reason });
  }
  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      slug: v.slug,
      label: v.label,
      note: "Reply in one short line saying what you need and why, then stop.",
    }),
    ms: Date.now() - start,
  };
}
