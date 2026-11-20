
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import {
  getAgentSetupSchema,
  probeSetupCompleteness,
} from "@/services/agents/setup-schema";
import { enqueueAgentRun } from "@/services/agents/runner";
import type { AgentTrigger } from "@/services/agents/types";

const Body = z.object({
  vault: z.record(z.string(), z.string().max(2000)),
  retry: z.boolean().default(false),
});

function isAgentTrigger(t: unknown): t is AgentTrigger {
  return (
    t === "manual" ||
    t === "cron" ||
    t === "slack" ||
    t === "webhook" ||
    t === "a2a" ||
    t === "chat" ||
    t === "handoff"
  );
}

export async function agentSetupPost(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = req.params.slug;
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({
        error: { code: "validation", message: parsed.error.message },
      });
    return;
  }

  const sb = serviceClient();
  const { data: tu, error: tuErr } = await sb
    .from("tenant_users")
    .select("role")
    .eq("user_id", auth.user_id)
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle();
  if (tuErr || !tu || tu.role !== "owner") {
    res.status(403).json({ error: { code: "owner_only" } });
    return;
  }

  const schema = await getAgentSetupSchema(slug, auth.tenant_id);
  if (!schema) {
    res.status(404).json({ error: { code: "agent_not_found" } });
    return;
  }
  const declaredKeys = new Set(schema.vault_keys.map((v) => v.key));

  const stripped: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.data.vault)) {
    if (v.length > 0) stripped[k] = v;
  }

  const undeclared = Object.keys(stripped).filter(
    (k) => !declaredKeys.has(k),
  );
  if (undeclared.length > 0) {
    res.status(400).json({
      error: {
        code: "undeclared_keys",
        message: `Agent did not declare keys: ${undeclared.join(", ")}`,
      },
    });
    return;
  }

  for (const [key, value] of Object.entries(stripped)) {
    const { error } = await sb.rpc("set_agent_setup_secret", {
      p_tenant_id: auth.tenant_id,
      p_agent_slug: slug,
      p_key: key,
      p_value: value,
    });
    if (error) {
      res
        .status(500)
        .json({
          error: { code: "vault_write_failed", message: error.message },
        });
      return;
    }
  }

  if (parsed.data.retry && Object.keys(stripped).length === 0) {
    const reProbe = await probeSetupCompleteness(auth.tenant_id, slug);
    if (!reProbe.ok && reProbe.missing_required_connectors.length > 0) {
      res.status(400).json({
        error: {
          code: "still_blocked",
          message:
            "Setup is still incomplete (missing required connectors). Connect the required tools first, then retry.",
          missing_required_connectors: reProbe.missing_required_connectors,
        },
      });
      return;
    }
  }

  const { data: state } = await sb
    .from("agent_setup_state")
    .select("blocked_run_id")
    .eq("tenant_id", auth.tenant_id)
    .eq("agent_slug", slug)
    .maybeSingle();
  const blocked_run_id = (state?.blocked_run_id ?? null) as string | null;

  await sb
    .from("agent_setup_state")
    .delete()
    .eq("tenant_id", auth.tenant_id)
    .eq("agent_slug", slug);

  let catalog_seed: { run_id: string } | null = null;
  if (slug === "qa" && typeof stripped["qa.staging_url"] === "string") {
    try {
      const { count, error: countErr } = await sb
        .from("test_cases")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", auth.tenant_id);
      if (countErr) {
        throw new Error(`test_cases count failed: ${countErr.message}`);
      }
      if ((count ?? 0) === 0) {
        const { data: inflightSeed, error: inflightErr } = await sb
          .from("agent_runs")
          .select("id")
          .eq("tenant_id", auth.tenant_id)
          .eq("agent_slug", "qa")
          .in("status", ["queued", "running"])
          .contains("payload", { mode: "catalog-build" })
          .limit(1);
        if (inflightErr) {
          throw new Error(`in-flight probe failed: ${inflightErr.message}`);
        }
        if ((inflightSeed ?? []).length === 0) {
          const seeded = await enqueueAgentRun({
            agent_slug: "qa",
            tenant_id: auth.tenant_id,
            trigger: "webhook",
            payload: {
              mode: "catalog-build",
              source: "qa-setup",
              staging_url: stripped["qa.staging_url"],
            },
          });
          catalog_seed = { run_id: seeded.run_id };
        }
      }
    } catch (e) {
      console.warn(
        `[agents/setup] qa catalog-build seed skipped for ${auth.tenant_id}: ${(e as Error).message}`,
      );
    }
  }

  let new_run_id: string | null = null;
  let retryError: string | null = null;
  if (parsed.data.retry) {
    let originalPayload: unknown = null;
    let originalTrigger: AgentTrigger = "manual";
    if (blocked_run_id) {
      const { data: prev } = await sb
        .from("agent_runs")
        .select("payload, trigger")
        .eq("id", blocked_run_id)
        .maybeSingle();
      if (prev) {
        originalPayload = prev.payload as unknown;
        const t = prev.trigger as unknown;
        if (isAgentTrigger(t)) originalTrigger = t;
      }
    }
    try {
      const r = await enqueueAgentRun({
        agent_slug: slug,
        tenant_id: auth.tenant_id,
        trigger: originalTrigger,
        payload: originalPayload as object | null,
      });
      new_run_id = r.run_id;
    } catch (e) {
      retryError = (e as Error).message;
    }
  }
  res.json({
    ok: true,
    wrote: Object.keys(stripped),
    catalog_seed,
    retry: new_run_id
      ? { ok: true, run_id: new_run_id }
      : retryError
        ? { ok: false, error: retryError }
        : null,
  });
}
