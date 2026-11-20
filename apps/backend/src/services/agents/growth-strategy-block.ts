
import { escape_for_prompt } from "./prompt-injection";
import { sanitizeGapAnswer } from "@/services/memory/brain-slots";
import { asTenantId, tenantClient } from "@/services/tenant-client";

const CURRENT_STRATEGY_TAG = "current-growth-strategy";

type StrategyMetadata = {
  accepted?: unknown;
  strategy?: {
    north_star?: { metric?: unknown; why?: unknown };
    constraint?: { statement?: unknown; lever_family?: unknown; confidence?: unknown };
    channel_bets?: Array<{ channel_slug?: unknown }>;
    goal?: { objective?: unknown; target_metric?: unknown; target_value?: unknown; due_date?: unknown };
  };
};

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clean(v: unknown): string {
  return escape_for_prompt(sanitizeGapAnswer(s(v)));
}

export type FounderSay = {
  constraint?: string | null;
  stopped?: readonly string[];
};

export function renderGrowthStrategyBlock(meta: unknown, founder: FounderSay = {}): string | undefined {
  if (meta === null || typeof meta !== "object") return undefined;
  const m = meta as StrategyMetadata;

  if (m.accepted !== true) return undefined;

  const st = m.strategy;
  if (!st || typeof st !== "object") return undefined;

  const metric = s(st.north_star?.metric);
  const constraint = s(st.constraint?.statement);
  if (!metric || !constraint) return undefined;

  const lines: string[] = ["<growth_strategy>"];
  lines.push(
    "The founder has accepted this growth strategy. Treat it as the company's stated direction:",
  );
  lines.push(`- North Star metric: ${clean(metric)}`);

  const why = s(st.north_star?.why);
  if (why) lines.push(`  Why: ${clean(why)}`);

  const confidence = s(st.constraint?.confidence);
  const lever = s(st.constraint?.lever_family);
  const own = s(founder.constraint);
  lines.push(
    own
      ?
        `- The binding constraint, in the founder's own words (plan around it; do not replace it): ${clean(own)}`
      : `- The binding constraint${lever ? ` (${clean(lever)})` : ""}: ${clean(constraint)}` +
          (confidence && confidence !== "high" ? ` [confidence: ${clean(confidence)}]` : ""),
  );

  const bets = (Array.isArray(st.channel_bets) ? st.channel_bets : [])
    .map((b) => s(b?.channel_slug))
    .filter(Boolean)
    .slice(0, 3);
  if (bets.length > 0) {
    lines.push(`- Channels being bet on: ${bets.map((b) => clean(b)).join(", ")}`);
  }

  const stopped = (founder.stopped ?? []).map(s).filter(Boolean);
  if (stopped.length > 0) {
    lines.push(`- Channels the founder stopped (never bet on, run or propose work for them): ${stopped.map((b) => clean(b)).join(", ")}`);
  }

  const g = st.goal;
  const gObjective = s(g?.objective);
  const gMetric = s(g?.target_metric);
  const gValue = typeof g?.target_value === "number" ? g.target_value : null;
  const gDue = s(g?.due_date);
  if (gObjective && gMetric && gValue !== null && gDue) {
    lines.push(
      `- Primary goal: ${clean(gObjective)} — ${clean(gMetric)} to ${gValue} by ${clean(gDue)}`,
    );
  }

  lines.push(
    "Work that serves this constraint comes first. If your read of the data contradicts it, say so plainly rather than quietly working around it.",
  );
  lines.push("</growth_strategy>");
  return lines.join("\n");
}

export async function buildGrowthStrategyBlock(
  tenant_id: string,
): Promise<string | undefined> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("memory_note")
      .select("metadata")
      .eq("note_type", "growth_strategy")
      .contains("tags", [CURRENT_STRATEGY_TAG])
      .is("superseded_by", null)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error || !Array.isArray(data) || !data[0]) return undefined;
    return renderGrowthStrategyBlock((data[0] as { metadata?: unknown }).metadata, await readFounderSay(tenant_id));
  } catch {
    return undefined;
  }
}

async function readFounderSay(tenant_id: string): Promise<FounderSay> {
  try {
    const db = tenantClient(asTenantId(tenant_id));
    const [plan, channels] = await Promise.all([
      db.from("growth_plan").select("founder_constraint").eq("tenant_id", tenant_id).eq("status", "live").order("created_at", { ascending: false }).limit(1),
      db.from("tenant_channels").select("channel_slug").eq("tenant_id", tenant_id).eq("plan_selected_set_by", "founder_stopped"),
    ]);
    return {
      constraint: plan.error ? null : ((plan.data?.[0] as { founder_constraint?: string | null } | undefined)?.founder_constraint ?? null),
      stopped: channels.error ? [] : ((channels.data ?? []) as Array<{ channel_slug: string }>).map((c) => c.channel_slug).sort(),
    };
  } catch {
    return {};
  }
}
