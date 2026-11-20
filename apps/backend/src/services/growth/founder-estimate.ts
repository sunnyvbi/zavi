
import { asTenantId, tenantClient } from "@/services/tenant-client";

const CUSTOMER_METRICS = new Set(["customers", "new_customers", "paying_customers", "new_paying_customers"]);

export function isNewCustomersGoal(g: { target_metric: string | null | undefined; objective: string | null | undefined }): boolean {
  const metric = (g.target_metric ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (CUSTOMER_METRICS.has(metric)) return true;
  if (metric && metric !== "unmapped") return false;
  return /\bnew (paying )?customers\b/i.test(g.objective ?? "");
}

export function founderEstimateLine(answer: string | null | undefined): string | null {
  const a = (answer ?? "").trim();
  if (!a || /not sure/i.test(a)) return null;
  return `You told me ${a} new customer${a === "1" ? "" : "s"} last month`;
}

export function founderEstimateFor(
  g: { target_metric: string | null | undefined; objective: string | null | undefined },
  answer: string | null | undefined,
): string | null {
  return isNewCustomersGoal(g) ? founderEstimateLine(answer) : null;
}

export async function readFounderCustomersAnswer(tenant_id: string): Promise<string | null> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("memory_note")
      .select("customers:metadata->interview->answers->>customers")
      .eq("note_type", "growth_strategy")
      .not("metadata->interview->answers->>customers", "is", null)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error || !Array.isArray(data)) return null;
    const value = (data[0] as { customers?: unknown } | undefined)?.customers;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}
