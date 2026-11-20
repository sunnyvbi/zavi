
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";
import { listAgents } from "@/services/agents/registry";
import { pickProvider } from "@/services/agents/engine/pick-engine";
import { assertModelMatchesProvider, MODELS } from "@/services/llm/models";
import { refusesConversationalAgent } from "@/services/agents/engine/conversational-guard";

const MODEL_OPTIONS: Record<
  "anthropic" | "openai" | "bedrock" | "fireworks" | "langchain",
  string[]
> = {
  anthropic: [MODELS.anthropic.opus, MODELS.anthropic.sonnet, MODELS.anthropic.haiku],
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
  bedrock: ["qwen.qwen3-next-80b-a3b-instruct", "zai.glm-5"],
  fireworks: ["accounts/fireworks/models/glm-5p2"],
  langchain: [
    "gpt-5.5",
    `anthropic:${MODELS.anthropic.sonnet}`,
    `anthropic:${MODELS.anthropic.opus}`,
    "accounts/fireworks/models/kimi-k3",
    "accounts/fireworks/models/glm-5p2",
  ],
};

async function tenantExists(id: string): Promise<boolean> {
  const { data } = await serviceClient()
    .from("tenants")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  return !!data;
}

export async function staffEngineOverrideGet(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);
  const tenantId = String(req.query.tenant_id ?? "");
  if (!tenantId || !(await tenantExists(tenantId))) {
    res
      .status(404)
      .json({ error: { code: "tenant_not_found", message: tenantId } });
    return;
  }

  const { data: rows, error } = await serviceClient()
    .from("tenant_agent_provider_overrides")
    .select("agent_slug, provider, model, note, updated_at")
    .eq("tenant_id", tenantId);
  if (error) {
    res
      .status(500)
      .json({ error: { code: "read_failed", message: error.message } });
    return;
  }
  type Row = {
    agent_slug: string;
    provider: string;
    model: string;
    note: string | null;
    updated_at: string;
  };
  const bySlug = new Map(((rows ?? []) as Row[]).map((r) => [r.agent_slug, r]));

  const agents = listAgents()
    .map((a) => {
      const defaultProvider = pickProvider(a.metadata_praxis);
      const defaultModel = a.metadata_praxis.model;
      const ov = bySlug.get(a.slug);
      return {
        slug: a.slug,
        name: a.name,
        default_provider: defaultProvider,
        default_model: defaultModel,
        override_provider: ov?.provider ?? null,
        override_model: ov?.model ?? null,
        effective_provider: ov?.provider ?? defaultProvider,
        effective_model: ov?.model ?? defaultModel,
        source: ov ? "tenant_override" : "agent_default",
        note: ov?.note ?? null,
        updated_at: ov?.updated_at ?? null,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  res.json({ tenant_id: tenantId, agents, model_options: MODEL_OPTIONS });
}

export const SetBody = z.object({
  tenant_id: z.string().uuid(),
  agent_slug: z.string().min(1),
  provider: z.enum(["anthropic", "openai", "bedrock", "fireworks", "langchain"]),
  model: z.string().min(1),
});

export async function staffEngineOverrideSet(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  const parsed = SetBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const { tenant_id, agent_slug, provider, model } = parsed.data;

  const known = new Set(listAgents().map((a) => a.slug));
  if (!known.has(agent_slug)) {
    res
      .status(400)
      .json({ error: { code: "unknown_agent_slug", message: agent_slug } });
    return;
  }
  if (refusesConversationalAgent(provider, agent_slug)) {
    const PROVIDER_LABELS: Record<string, string> = {
      bedrock: "Bedrock",
      fireworks: "Fireworks",
      langchain: "LangChain Deep Agents",
    };
    const label = PROVIDER_LABELS[provider] ?? provider;
    res.status(400).json({
      error: {
        code: `${provider}_conversational_unsupported`,
        message:
          `agent "${agent_slug}" is conversational; ${label} (stateless, no ` +
          `session resume) cannot run it until conversational-resume ships. ` +
          `Canary a stateless agent on ${provider} instead (research, growth-lead, ` +
          `performance-marketer).` +
          (provider === "langchain"
            ? ` To evaluate chat on the Deep Agents harness, set ` +
              `PRAXIS_DEEPAGENT_ALLOW_CONVERSATIONAL=1 (operator stays pinned to ` +
              `the inline Claude funnel either way).`
            : ""),
      },
    });
    return;
  }
  try {
    assertModelMatchesProvider(provider, model);
  } catch (e) {
    res.status(400).json({
      error: {
        code: "provider_model_mismatch",
        message: (e as Error).message,
      },
    });
    return;
  }
  if (!(await tenantExists(tenant_id))) {
    res
      .status(404)
      .json({ error: { code: "tenant_not_found", message: tenant_id } });
    return;
  }

  const { error } = await serviceClient().rpc("set_tenant_agent_provider", {
    p_tenant_id: tenant_id,
    p_agent_slug: agent_slug,
    p_provider: provider,
    p_model: model,
    p_note: `staff:${staff.email}`,
  });
  if (error) {
    res
      .status(500)
      .json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "engine_override.set",
    target_table: "tenant_agent_provider_overrides",
    target_id: tenant_id,
    meta: { tenant_id, agent_slug, provider, model },
  });

  res.json({ ok: true });
}

export const ClearBody = z.object({
  tenant_id: z.string().uuid(),
  agent_slug: z.string().min(1),
});

export async function staffEngineOverrideClear(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  const parsed = ClearBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const { tenant_id, agent_slug } = parsed.data;

  const { error } = await serviceClient().rpc("clear_tenant_agent_provider", {
    p_tenant_id: tenant_id,
    p_agent_slug: agent_slug,
  });
  if (error) {
    res
      .status(500)
      .json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "engine_override.clear",
    target_table: "tenant_agent_provider_overrides",
    target_id: tenant_id,
    meta: { tenant_id, agent_slug },
  });

  res.json({ ok: true });
}

export const MasterKillBody = z.object({
  provider_overrides_disabled: z.boolean(),
});

export async function staffEngineOverrideMasterKill(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  const parsed = MasterKillBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const { provider_overrides_disabled } = parsed.data;

  const sb = serviceClient();
  const { data: current, error: readErr } = await sb
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: Record<string, unknown> }>();
  if (readErr) {
    res
      .status(500)
      .json({ error: { code: "read_failed", message: readErr.message } });
    return;
  }

  const before = current?.blob ?? {};
  const after = { ...before, provider_overrides_disabled };

  const { error: upsertErr } = await sb.from("system_config").upsert(
    {
      id: 1,
      blob: after,
      updated_at: new Date().toISOString(),
      updated_by: staff.user_id,
    },
    { onConflict: "id" },
  );
  if (upsertErr) {
    res
      .status(500)
      .json({ error: { code: "write_failed", message: upsertErr.message } });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: `engine_override.master_kill.${provider_overrides_disabled ? "engage" : "clear"}`,
    target_table: "system_config",
    target_id: "1",
    meta: {
      provider_overrides_disabled,
      previous: before.provider_overrides_disabled === true,
    },
  });

  res.json({ ok: true, provider_overrides_disabled });
}
