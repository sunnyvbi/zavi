
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import { fromTracedToolName } from "@/services/mcp/types";
import {
  escape_for_prompt,
  renderUntrustedBlock,
} from "@/services/agents/prompt-injection";
import type { ToolCallTrace } from "@/services/tools/types";

export const CONNECTOR_SKILL_FLAG = "connector_skill_compounding_enabled" as const;

export const MAX_FACTS_PER_CONNECTOR = 25;

export type ConnectorSkillKind = "tool_used" | "identity";

export type ConnectorSkillFact = {
  key: string;
  text: string;
  kind: ConnectorSkillKind;
};

type ConnectorIdentity = {
  team_name?: string | null;
  account_login?: string | null;
};

function sanitizeIdentityValue(raw: string): string {
  return escape_for_prompt(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/[`<>[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function sanitizeToolName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

export function deriveConnectorSkillFacts(params: {
  toolCalls: ToolCallTrace[];
  connectedProviders: ReadonlySet<string>;
  identities: ReadonlyMap<string, ConnectorIdentity>;
}): Map<string, ConnectorSkillFact[]> {
  const { toolCalls, connectedProviders, identities } = params;
  const byProvider = new Map<string, Map<string, ConnectorSkillFact>>();

  const ensure = (provider: string): Map<string, ConnectorSkillFact> => {
    let m = byProvider.get(provider);
    if (!m) {
      m = new Map();
      byProvider.set(provider, m);
    }
    return m;
  };

  for (const tc of toolCalls) {
    if (!tc || tc.status !== "ok" || typeof tc.name !== "string") continue;
    const route = fromTracedToolName(tc.name);
    if (!route) continue;
    const provider = route.server_id;
    if (!connectedProviders.has(provider)) continue;
    const tool = sanitizeToolName(route.tool_name);
    if (!tool) continue;
    const key = `tool:${tool}`;
    const m = ensure(provider);
    if (!m.has(key)) {
      m.set(key, {
        key,
        text: `Has successfully used the \`${tool}\` tool on this connector.`,
        kind: "tool_used",
      });
    }
  }

  for (const provider of byProvider.keys()) {
    const id = identities.get(provider);
    if (!id) continue;
    const m = ensure(provider);
    const team = id.team_name ? sanitizeIdentityValue(id.team_name) : "";
    if (team) {
      m.set("identity:workspace", {
        key: "identity:workspace",
        text: `Connected workspace/account: ${team}.`,
        kind: "identity",
      });
    }
    const login = id.account_login ? sanitizeIdentityValue(id.account_login) : "";
    if (login) {
      m.set("identity:account", {
        key: "identity:account",
        text: `Connected account login: ${login}.`,
        kind: "identity",
      });
    }
  }

  const out = new Map<string, ConnectorSkillFact[]>();
  for (const [provider, m] of byProvider) {
    if (m.size > 0) out.set(provider, [...m.values()]);
  }
  return out;
}

export async function recordConnectorSkillForRun(params: {
  tenant_id: string;
  tool_calls: unknown;
  run_id?: string | null;
}): Promise<{ providers: number; facts: number }> {
  const { tenant_id } = params;
  if (typeof tenant_id !== "string" || tenant_id.length === 0) {
    return { providers: 0, facts: 0 };
  }
  const run_id =
    typeof params.run_id === "string" && params.run_id.length > 0
      ? params.run_id
      : null;

  let on = false;
  try {
    on = await getBoolSetting(CONNECTOR_SKILL_FLAG, tenant_id);
  } catch {
    on = false;
  }
  if (!on) return { providers: 0, facts: 0 };

  const toolCalls = Array.isArray(params.tool_calls)
    ? (params.tool_calls as ToolCallTrace[])
    : [];
  if (toolCalls.length === 0) return { providers: 0, facts: 0 };

  const sb = serviceClient();

  let rows: Array<{
    slug: string;
    team_name: string | null;
    account_login: string | null;
  }> = [];
  try {
    const { data, error } = await sb
      .from("connector_metadata")
      .select("slug, team_name, account_login")
      .eq("tenant_id", tenant_id);
    if (error) {
      console.warn(
        `[connector-skill] connector_metadata read failed for tenant=${tenant_id}: ${error.message}`,
      );
      return { providers: 0, facts: 0 };
    }
    rows = (data ?? []) as typeof rows;
  } catch (e) {
    console.warn(
      `[connector-skill] connector_metadata exception for tenant=${tenant_id}: ${(e as Error).message}`,
    );
    return { providers: 0, facts: 0 };
  }
  if (rows.length === 0) return { providers: 0, facts: 0 };

  const connectedProviders = new Set<string>();
  const identities = new Map<string, ConnectorIdentity>();
  for (const r of rows) {
    if (typeof r.slug === "string" && r.slug.length > 0) {
      connectedProviders.add(r.slug);
      identities.set(r.slug, {
        team_name: r.team_name,
        account_login: r.account_login,
      });
    }
  }

  const factsByProvider = deriveConnectorSkillFacts({
    toolCalls,
    connectedProviders,
    identities,
  });
  if (factsByProvider.size === 0) return { providers: 0, facts: 0 };

  let providers = 0;
  let facts = 0;
  for (const [provider, providerFacts] of factsByProvider) {
    try {
      const { error } = await sb.rpc("record_connector_skill_facts", {
        p_tenant_id: tenant_id,
        p_provider: provider,
        p_facts: providerFacts.map((f) => ({
          key: f.key,
          text: f.text,
          kind: f.kind,
        })),
        p_run_id: run_id,
      });
      if (error) {
        console.warn(
          `[connector-skill] upsert failed for tenant=${tenant_id} provider=${provider}: ${error.message}`,
        );
        continue;
      }
      providers += 1;
      facts += providerFacts.length;
    } catch (e) {
      console.warn(
        `[connector-skill] upsert exception for tenant=${tenant_id} provider=${provider}: ${(e as Error).message}`,
      );
    }
  }
  return { providers, facts };
}

export function renderLearnedFactsBlock(
  provider: string,
  facts: ConnectorSkillFact[],
): string {
  if (facts.length === 0) return "";
  const byKey = (a: ConnectorSkillFact, b: ConnectorSkillFact) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  const identity = facts.filter((f) => f.kind === "identity").sort(byKey);
  const tools = facts.filter((f) => f.kind !== "identity").sort(byKey);

  const parts: string[] = [`## What we've learned about your ${provider} connector`];
  if (identity.length > 0) {
    parts.push(
      renderUntrustedBlock(
        "connector_identity",
        identity.map((f) => `- ${f.text}`).join("\n"),
      ),
    );
  }
  if (tools.length > 0) parts.push(tools.map((f) => `- ${f.text}`).join("\n"));
  return parts.join("\n");
}

export async function loadLearnedConnectorFacts(
  tenant_id: string,
  providers: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (typeof tenant_id !== "string" || tenant_id.length === 0) return out;
  if (!Array.isArray(providers) || providers.length === 0) return out;

  const sb = serviceClient();

  const uniqueProviders = [...new Set(providers)];
  const perProvider = await Promise.all(
    uniqueProviders.map(async (provider) => {
      try {
        const { data, error } = await sb
          .from("tenant_connector_skill")
          .select("fact_key, fact_text, kind")
          .eq("tenant_id", tenant_id)
          .eq("provider", provider)
          .order("hits", { ascending: false })
          .order("fact_key", { ascending: true })
          .limit(MAX_FACTS_PER_CONNECTOR);
        if (error) {
          console.warn(
            `[connector-skill] learned-facts read failed for tenant=${tenant_id} provider=${provider}: ${error.message}`,
          );
          return null;
        }
        return { provider, rows: (data ?? []) as Array<{
          fact_key: string;
          fact_text: string;
          kind: string;
        }> };
      } catch (e) {
        console.warn(
          `[connector-skill] learned-facts exception for tenant=${tenant_id} provider=${provider}: ${(e as Error).message}`,
        );
        return null;
      }
    }),
  );

  for (const entry of perProvider) {
    if (!entry) continue;
    const facts: ConnectorSkillFact[] = [];
    for (const r of entry.rows) {
      if (typeof r.fact_text !== "string" || typeof r.fact_key !== "string") continue;
      facts.push({
        key: r.fact_key,
        text: r.fact_text,
        kind: r.kind === "identity" ? "identity" : "tool_used",
      });
    }
    if (facts.length === 0) continue;
    const block = renderLearnedFactsBlock(entry.provider, facts);
    if (block) out.set(entry.provider, block);
  }
  return out;
}
