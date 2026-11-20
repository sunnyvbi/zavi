
import type { ParsedStrategy } from "./strategy";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { escape_for_prompt } from "@/services/agents/prompt-injection";
import { sanitizeGapAnswer } from "@/services/memory/brain-slots";

export type FounderOverlay = {
  constraint: string | null;
  stopped: ReadonlySet<string>;
};

export const NO_OVERLAY: FounderOverlay = { constraint: null, stopped: new Set() };

export const FORCED_CONSTRAINT_KEY = "forced_constraint";

export function forcedConstraintOf(payload: unknown): string | null {
  const v = (payload as Record<string, unknown> | null | undefined)?.[FORCED_CONSTRAINT_KEY];
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : null;
}

export function applyFounderOverlay(s: ParsedStrategy, o: FounderOverlay): ParsedStrategy {
  const kept = o.stopped.size ? s.channel_bets.filter((b) => !o.stopped.has(b.channel_slug)) : s.channel_bets;
  const bets = kept.length === s.channel_bets.length ? s.channel_bets : kept;
  const constraint = o.constraint && o.constraint !== s.constraint.statement ? { ...s.constraint, statement: o.constraint } : s.constraint;
  if (bets === s.channel_bets && constraint === s.constraint) return s;
  return { ...s, constraint, channel_bets: bets };
}

export function founderDossierLine(o: FounderOverlay): string {
  const out: string[] = [];
  if (o.constraint) {
    out.push(
      "FOUNDER'S DIAGNOSIS (the founder's own view; constraint.statement is fixed to it, so judge how well the plan works around it, not whether it is right):\n" +
        escape_for_prompt(sanitizeGapAnswer(o.constraint)),
    );
  }
  if (o.stopped.size) out.push(`CHANNELS THE FOUNDER STOPPED (never a bet): ${[...o.stopped].sort().join(", ")}`);
  return out.length ? `${out.join("\n\n")}\n\n` : "";
}

export async function readFounderOverlay(tenant_id: string, payload?: unknown): Promise<FounderOverlay> {
  const forced = forcedConstraintOf(payload);
  try {
    const db = tenantClient(asTenantId(tenant_id));
    const [plan, stopped] = await Promise.all([
      db
        .from("growth_plan")
        .select("founder_constraint")
        .eq("tenant_id", tenant_id)
        .eq("status", "live")
        .order("created_at", { ascending: false })
        .limit(1),
      db
        .from("tenant_channels")
        .select("channel_slug")
        .eq("tenant_id", tenant_id)
        .eq("plan_selected_set_by", "founder_stopped"),
    ]);
    if (plan.error) throw new Error(`plan: ${plan.error.message}`);
    if (stopped.error) throw new Error(`channels: ${stopped.error.message}`);
    const own = (plan.data?.[0] as { founder_constraint?: string | null } | undefined)?.founder_constraint;
    return {
      constraint: forced ?? (typeof own === "string" && own.trim() ? own.trim() : null),
      stopped: new Set(((stopped.data ?? []) as Array<{ channel_slug: string }>).map((r) => r.channel_slug)),
    };
  } catch (e) {
    console.warn(`[cgo founder-overlay] unreadable for tenant ${tenant_id}: ${(e as Error).message}`);
    return { constraint: forced, stopped: new Set() };
  }
}
