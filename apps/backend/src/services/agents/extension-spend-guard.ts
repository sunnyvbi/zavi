
import type { Request } from "express";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { PAGE_CONTEXT_SURFACE } from "@/services/agents/page-context";

export const DEFAULT_EXTENSION_DAILY_CAP = Number(
  process.env.EXTENSION_DAILY_RUN_CAP ?? 50,
);

export function isExtensionChatTurn(req: Request): boolean {
  const body = req.body as { page_context?: unknown } | undefined;
  return Boolean(body && body.page_context);
}

export type DailyCapVerdict =
  | { allowed: true; used: number; cap: number }
  | { allowed: false; used: number; cap: number };

export async function checkExtensionDailyCap(
  tenant_id: string,
  cap: number = DEFAULT_EXTENSION_DAILY_CAP,
): Promise<DailyCapVerdict> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  try {
    const { count, error } = await tenantClient(asTenantId(tenant_id))
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("payload->>surface", PAGE_CONTEXT_SURFACE)
      .gte("enqueued_at", since.toISOString());

    if (error) return { allowed: true, used: 0, cap };
    const used = count ?? 0;
    return used >= cap ? { allowed: false, used, cap } : { allowed: true, used, cap };
  } catch {
    return { allowed: true, used: 0, cap };
  }
}

export async function checkExtensionScreenshotDailyCap(
  tenant_id: string,
  cap: number = DEFAULT_EXTENSION_DAILY_CAP,
): Promise<DailyCapVerdict> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  try {
    const { count, error } = await tenantClient(asTenantId(tenant_id))
      .from("extension_screenshots")
      .select("id", { count: "exact", head: true })
      .eq("kind", "turn")
      .gte("created_at", since.toISOString());

    if (error) return { allowed: true, used: 0, cap };
    const used = count ?? 0;
    return used >= cap ? { allowed: false, used, cap } : { allowed: true, used, cap };
  } catch {
    return { allowed: true, used: 0, cap };
  }
}
