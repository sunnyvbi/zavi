
import type { Provider } from "@/services/llm/models";
import {
  isAnthropicModel,
  assertModelMatchesProvider,
} from "@/services/llm/models";
import { serviceClient } from "@/services/supabase";
import { refusesConversationalAgent } from "./conversational-guard";
import type { AgentMetadata } from "../types";
import { pickProvider } from "./pick-engine";

export type ResolvedEngine = {
  provider: Provider;
  model: string;
  source: "agent_default" | "tenant_override";
};

async function areProviderOverridesDisabled(
  sb: ReturnType<typeof serviceClient>,
): Promise<boolean> {
  try {
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return true;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.provider_overrides_disabled === true;
  } catch {
    return true;
  }
}

export async function resolveRunEngine(
  tenantId: string,
  slug: string,
  meta: Pick<AgentMetadata, "provider" | "model">,
): Promise<ResolvedEngine> {
  const base: ResolvedEngine = {
    provider: pickProvider(meta),
    model: meta.model,
    source: "agent_default",
  };
  try {
    const sb = serviceClient();

    if (await areProviderOverridesDisabled(sb)) return base;

    const { data, error } = await sb
      .from("tenant_agent_provider_overrides")
      .select("provider, model")
      .eq("tenant_id", tenantId)
      .eq("agent_slug", slug)
      .maybeSingle();
    if (error || !data) return base;

    const provider = data.provider as Provider;
    const model = ((data.model as string) || "").trim() || base.model;

    if (provider === "openai" && isAnthropicModel(model)) {
      console.warn(
        `[resolve-run-engine] override ${tenantId}/${slug} has provider=openai ` +
          `but model="${model}" is a Claude model — ignoring, using agent default`,
      );
      return base;
    }

    try {
      assertModelMatchesProvider(provider, model);
    } catch (e) {
      console.warn(
        `[resolve-run-engine] override ${tenantId}/${slug} is provider/model-` +
          `inconsistent (${(e as Error).message}) — ignoring, using agent default`,
      );
      return base;
    }

    if (refusesConversationalAgent(provider, slug)) {
      console.warn(
        `[resolve-run-engine] override ${tenantId}/${slug} routes a conversational ` +
          `agent to ${provider} (no stateless resume yet) — ignoring, using agent default`,
      );
      return base;
    }

    return { provider, model, source: "tenant_override" };
  } catch (e) {
    console.warn(
      `[resolve-run-engine] override read failed for ${tenantId}/${slug}: ` +
        `${(e as Error).message} — using agent default`,
    );
    return base;
  }
}
