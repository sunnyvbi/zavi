
import { serviceClient } from "@/services/supabase";

export type RoadmapDigestRow = {
  theme: string | null;
  status: "proposed" | "in_flight" | "shipped" | "measured" | string;
  outcome: "won" | "recurred" | null;
  baseline_query: string | null;
  baseline_value: number | null;
};

export function shouldRenderRoadmapDigest(now: Date): boolean {
  return now.getUTCDay() === 1;
}

export function renderRoadmapDigestBlock(rows: readonly RoadmapDigestRow[]): string {
  if (!rows || rows.length === 0) return "";

  const measured = rows.filter((r) => r.status === "measured" || r.status === "shipped");
  const inFlight = rows.filter((r) => r.status === "in_flight");
  const proposed = rows.filter((r) => r.status === "proposed");

  if (measured.length === 0 && inFlight.length === 0 && proposed.length === 0) return "";

  const lines: string[] = [];
  lines.push("");
  lines.push(":world_map: *Product roadmap — this week*");

  if (measured.length > 0) {
    lines.push("*Measured:*");
    for (const r of measured.slice(0, 5)) {
      const theme = (r.theme ?? "(untitled)").slice(0, 100);
      lines.push(`• ${theme} — ${describeOutcome(r)}`);
    }
  }

  if (inFlight.length > 0) {
    lines.push("*In flight:*");
    for (const r of inFlight.slice(0, 5)) {
      lines.push(`• ${(r.theme ?? "(untitled)").slice(0, 100)}`);
    }
  }

  if (proposed.length > 0) {
    const lead = proposed.slice(0, 3);
    lines.push("*Proposed:*");
    for (const r of lead) {
      lines.push(`• ${(r.theme ?? "(untitled)").slice(0, 100)}`);
    }
    const more = proposed.length - lead.length;
    if (more > 0) lines.push(`_+${more} more proposed._`);
  }

  return lines.join("\n");
}

function describeOutcome(r: RoadmapDigestRow): string {
  const parts: string[] = [];
  if (r.outcome === "won") parts.push("fix held :white_check_mark:");
  else if (r.outcome === "recurred") parts.push("recurred — re-surfaced :warning:");
  else parts.push("shipped");
  if (r.baseline_query && typeof r.baseline_value === "number") {
    parts.push(`tracking ${prettyQuery(r.baseline_query)} (baseline ${r.baseline_value})`);
  }
  return parts.join(", ");
}

function prettyQuery(q: string): string {
  switch (q) {
    case "query_funnel_by_geo_category":
      return "funnel";
    case "query_recent_transactions":
      return "transactions";
    case "query_active_supply_by_geo_category":
      return "active supply";
    default:
      return q;
  }
}

export async function fetchRoadmapDigestRows(tenant_id: string): Promise<RoadmapDigestRow[]> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("pm_roadmap")
      .select("theme, status, outcome, baseline_query, baseline_value")
      .eq("tenant_id", tenant_id)
      .in("status", ["proposed", "in_flight", "shipped", "measured"])
      .order("updated_at", { ascending: false })
      .limit(30);
    if (error) {
      console.warn(`[roadmap-digest] read failed for tenant=${tenant_id}: ${error.message}`);
      return [];
    }
    return (data ?? []) as RoadmapDigestRow[];
  } catch (e) {
    console.warn(`[roadmap-digest] read threw for tenant=${tenant_id}: ${(e as Error).message}`);
    return [];
  }
}
