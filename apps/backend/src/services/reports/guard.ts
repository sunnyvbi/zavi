
import { serviceClient } from "@/services/supabase";
import { ExpectedToolError } from "@/services/tools/types";
import { decideTenantOwnership } from "@/services/governance/tenant-ownership";

export type RunTenantOwnershipCtx = {
  tenant_id: string;
  run_id: string;
};

export async function assertRunTenantOwnership(
  ctx: RunTenantOwnershipCtx,
): Promise<string> {
  const svc = serviceClient();
  const { data: runRow, error: runErr } = await svc
    .from("agent_runs")
    .select("tenant_id")
    .eq("id", ctx.run_id)
    .single();
  if (runErr || !runRow) {
    throw new ExpectedToolError(
      "run_lookup_failed",
      runErr?.message ?? "run not found",
    );
  }
  const canonical = (runRow as { tenant_id: string }).tenant_id;
  const ownership = decideTenantOwnership({
    callerTenantId: ctx.tenant_id,
    canonicalTenantId: canonical,
  });
  if (!ownership.allow) {
    throw new ExpectedToolError(
      "tenant_mismatch",
      "run does not belong to the calling tenant.",
    );
  }
  return canonical;
}
