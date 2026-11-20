
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import {
  classifyUsageLimitStatus,
  type UsageLimitRunRow,
} from "@/services/agents/usage-limit-status";
import { preferApiKeyFromEnv } from "@/services/agents/agent-auth";

export async function staffUsageLimitStatus(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);

  const minutesRaw = Number(req.query.minutes ?? 30);
  const minutes =
    Number.isFinite(minutesRaw) && minutesRaw > 0
      ? Math.min(minutesRaw, 1440)
      : 30;
  const sinceISO = new Date(Date.now() - minutes * 60_000).toISOString();

  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("id, agent_slug, tenant_id, status, error, finished_at")
    .gte("finished_at", sinceISO)
    .order("finished_at", { ascending: false })
    .limit(500);

  if (error) {
    res
      .status(500)
      .json({ error: { code: "read_failed", message: error.message } });
    return;
  }

  const verdict = classifyUsageLimitStatus((data ?? []) as UsageLimitRunRow[]);

  const authMode = preferApiKeyFromEnv()
    ? "api_key"
    : "subscription_oauth";

  const advice = buildAdvice(verdict.limited, authMode, verdict.resets_at);

  res.json({
    window_minutes: minutes,
    auth_mode: authMode,
    advice,
    ...verdict,
  });
}

function buildAdvice(
  limited: boolean,
  authMode: "api_key" | "subscription_oauth",
  resetsAt: string | null,
): string {
  if (!limited) return "Fleet is not usage-limited right now.";
  const reset = resetsAt ? ` Cap resets ${resetsAt}.` : "";
  if (authMode === "subscription_oauth") {
    return (
      `Fleet is wedged on the Claude SUBSCRIPTION cap.${reset} ` +
      `Swapping ANTHROPIC_API_KEY does NOT help — prod bills the OAuth ` +
      `subscription token, not the API key. Either wait for the reset, or set ` +
      `PRAXIS_AGENT_AUTH_MODE=api_key + ANTHROPIC_API_KEY in Secrets Manager and ` +
      `restart the container to bill the key's quota instead.`
    );
  }
  return (
    `Fleet is wedged on the Claude API-KEY quota.${reset} ` +
    `Raise the key's limit/credits or wait for the reset. Update the key in ` +
    `Secrets Manager (praxis-envprod-1) and restart the container to load it.`
  );
}
