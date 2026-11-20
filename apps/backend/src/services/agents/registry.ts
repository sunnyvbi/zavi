
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import matter from "gray-matter";
import {
  AgentMetadataSchema,
  type AgentDefinition,
  type DispatcherFn,
} from "./types";
import { dispatchers, type DispatcherSlug } from "@/agents/index";
import { canonicalAgentSlug } from "@/agents/content-design/constants";
import { serviceClient } from "@/services/supabase";
import { isCustomAgentSlug } from "@/services/billing/tiers";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");

export { canonicalAgentSlug };

export function listGlobalAgentSlugs(): string[] {
  if (!fs.existsSync(AGENTS_ROOT)) return [];
  return fs
    .readdirSync(AGENTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .filter((slug) => fs.existsSync(path.join(AGENTS_ROOT, slug, "agent.md")));
}

export const listAgentSlugs = listGlobalAgentSlugs;

function buildDefinitionFromMarkdown(
  slug: string,
  raw: string,
  body_path: string,
): AgentDefinition {
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  const metaPraxisRaw =
    ((fm.metadata as Record<string, unknown> | undefined)?.praxis ?? {}) as
      Record<string, unknown>;
  const metadata_praxis = AgentMetadataSchema.parse(metaPraxisRaw);
  const content_hash = crypto
    .createHash("sha256")
    .update(raw)
    .digest("hex")
    .slice(0, 16);
  return {
    slug,
    name: (fm.name as string) ?? slug,
    description: (fm.description as string) ?? "",
    body_markdown: parsed.content,
    body_path,
    content_hash,
    metadata_praxis,
  };
}

export function loadGlobalAgentDefinition(slug: string): AgentDefinition | null {
  const canonical = canonicalAgentSlug(slug);
  const body_path = path.join(AGENTS_ROOT, canonical, "agent.md");
  if (!fs.existsSync(body_path)) return null;
  const raw = fs.readFileSync(body_path, "utf-8");
  return buildDefinitionFromMarkdown(canonical, raw, body_path);
}

export { agentCapabilities, type AgentCapabilities } from "./agent-capabilities";

type TenantAgentRow = {
  tenant_id: string;
  slug: string;
  version: number;
  body_markdown: string;
  frontmatter: Record<string, unknown>;
};

async function loadTenantActiveVersion(
  tenant_id: string,
  slug: string,
): Promise<TenantAgentRow | null> {
  const { data, error } = await serviceClient()
    .from("tenant_agents")
    .select("tenant_id, slug, version, body_markdown, frontmatter")
    .eq("tenant_id", tenant_id)
    .eq("slug", slug)
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`tenant_agents read failed: ${error.message}`);
  }
  return (data as TenantAgentRow | null) ?? null;
}

function tenantAgentToDefinition(
  row: TenantAgentRow,
): AgentDefinition {
  const fm = row.frontmatter ?? {};
  const metaPraxisRaw =
    ((fm.metadata as Record<string, unknown> | undefined)?.praxis ?? {}) as
      Record<string, unknown>;
  const metadata_praxis = AgentMetadataSchema.parse(metaPraxisRaw);
  const synth = `(tenant_agents row · ${row.tenant_id} · ${row.slug} · v${row.version})`;
  const content_hash = crypto
    .createHash("sha256")
    .update(`${row.tenant_id}|${row.slug}|${row.version}|${row.body_markdown}`)
    .digest("hex")
    .slice(0, 16);
  return {
    slug: row.slug,
    name: (fm.name as string) ?? row.slug,
    description: (fm.description as string) ?? "",
    body_markdown: row.body_markdown,
    body_path: synth,
    content_hash,
    metadata_praxis,
  };
}

export async function loadAgentDefinition(
  slug: string,
  tenant_id?: string,
): Promise<AgentDefinition | null> {
  const canonical = canonicalAgentSlug(slug);
  if (isCustomAgentSlug(canonical)) {
    if (tenant_id) {
      const { loadCustomAgentRow, customAgentToDefinition } = await import("./custom-agents");
      const row = await loadCustomAgentRow(tenant_id, canonical);
      if (row) return customAgentToDefinition(row);
    }
    return loadGlobalAgentDefinition(canonical);
  }
  if (tenant_id) {
    try {
      const row = await loadTenantActiveVersion(tenant_id, canonical);
      if (row) return tenantAgentToDefinition(row);
      if (slug !== canonical) {
        const legacy = await loadTenantActiveVersion(tenant_id, slug);
        if (legacy) return tenantAgentToDefinition({ ...legacy, slug: canonical });
      }
    } catch (e) {
      console.warn(`[registry] tenant_agents lookup failed: ${(e as Error).message}; falling back to global`);
    }
  }
  return loadGlobalAgentDefinition(canonical);
}

export function listAgents(): AgentDefinition[] {
  return listGlobalAgentSlugs()
    .map((slug) => loadGlobalAgentDefinition(slug))
    .filter((a): a is AgentDefinition => a !== null);
}

export const LISTED_AGENT_SLUGS: readonly string[] = ["operator"];

export function listAlwaysOnSlugs(): string[] {
  return listAgents()
    .filter((a) => a.metadata_praxis.visibility?.default_state === "always_on")
    .map((a) => a.slug);
}

export function listDefaultDisabledSlugs(): string[] {
  return listAgents()
    .filter((a) => a.metadata_praxis.visibility?.default_state === "disabled")
    .map((a) => a.slug);
}

export function getAgentDefaultState(
  slug: string,
): "enabled" | "disabled" | "always_on" {
  const agent = loadGlobalAgentDefinition(slug);
  return agent?.metadata_praxis.visibility?.default_state ?? "enabled";
}

export function isChannelOnlyAgent(slug: string): boolean {
  return loadGlobalAgentDefinition(slug)?.metadata_praxis.visibility?.channel_only === true;
}

export function getAgentShapeConstraints(
  slug: string,
): { recommended_for_shapes?: string[]; hidden_for_shapes?: string[] } | null {
  const agent = loadGlobalAgentDefinition(slug);
  const vis = agent?.metadata_praxis.visibility;
  if (!vis) return null;
  const hidden = vis.hidden_for_shapes;
  const recommended = vis.recommended_for_shapes;
  const hasHidden = Array.isArray(hidden) && hidden.length > 0;
  const hasRecommended = Array.isArray(recommended) && recommended.length > 0;
  if (!hasHidden && !hasRecommended) return null;
  return {
    ...(hasRecommended ? { recommended_for_shapes: recommended } : {}),
    ...(hasHidden ? { hidden_for_shapes: hidden } : {}),
  };
}

export function getDispatcher(slug: string): DispatcherFn | null {
  const canonical = canonicalAgentSlug(slug);
  if (canonical in dispatchers) {
    return dispatchers[canonical as DispatcherSlug];
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars

export function isChatEligible(_def: AgentDefinition): boolean {
  return true;
}
