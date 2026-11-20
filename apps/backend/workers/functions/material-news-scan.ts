
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import {
  isMaterialNewsRolloutEnabled,
  isMaterialNewsOptedIn,
} from "@/agents/material-news/material-news-flag";
import { scanTenant } from "@/services/material-news/scan";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

type TenantRow = { id: string; display_name: string | null };

type TenantOutcome =
  | { status: "skipped"; reason: string }
  | { status: "scanned"; inserted: number };

export async function runScanForTenant(tenant: TenantRow): Promise<TenantOutcome> {
  if (!(await isMaterialNewsRolloutEnabled(tenant.id))) {
    return { status: "skipped", reason: "rollout_off" };
  }
  if (!(await isMaterialNewsOptedIn(tenant.id))) {
    return { status: "skipped", reason: "opted_out" };
  }
  if (await isFleetHalted()) {
    return { status: "skipped", reason: "fleet_halt" };
  }
  const scan_day = new Date().toISOString().slice(0, 10);
  const { data: won, error: claimErr } = await serviceClient().rpc("claim_news_scan_day", {
    p_tenant_id: tenant.id,
    p_scan_day: scan_day,
  });
  if (claimErr) {
    throw new Error(`claim_news_scan_day failed: ${claimErr.message}`);
  }
  if (won !== true) {
    return { status: "skipped", reason: "already_scanned_today" };
  }

  const out = await scanTenant({ id: tenant.id });
  if (out.status === "skipped") return { status: "skipped", reason: out.reason };
  return { status: "scanned", inserted: out.inserted };
}

export const materialNewsScanFn = inngest.createFunction(
  { id: "material-news-scan", concurrency: 1 },
  { cron: "0 8 * * *" },
  async ({ step }) => {
    if (isWorkerCronStopped("material-news-scan")) {
      return { halted: false, cron_stopped: true as const, scanned: 0, inserted: 0, skipped: 0 };
    }
    const halted = await step.run("check-fleet-halt", async () => isFleetHalted());
    if (halted) return { halted: true, scanned: 0, inserted: 0, skipped: 0 };

    const tenants = await step.run("scan-tenants", async () => {
      const svc = serviceClient();
      const { data, error } = await svc.from("tenants").select("id, display_name");
      if (error) throw new Error(`material-news-scan: tenant scan failed: ${error.message}`);
      return (data ?? []) as TenantRow[];
    });

    let inserted = 0;
    let scanned = 0;
    let skipped = 0;
    const skippedTenants: Array<{ tenant_id: string; reason: string }> = [];

    for (const tenant of tenants) {
      try {
        const outcome = (await step.run(`tenant-${tenant.id}`, () =>
          runScanForTenant(tenant),
        )) as TenantOutcome;
        if (outcome.status === "skipped") {
          skipped++;
          skippedTenants.push({ tenant_id: tenant.id, reason: outcome.reason });
        } else {
          scanned++;
          inserted += outcome.inserted;
        }
      } catch (e) {
        skipped++;
        skippedTenants.push({ tenant_id: tenant.id, reason: (e as Error).message });
        console.error(`[material-news-scan] tenant=${tenant.id} threw: ${(e as Error).message}`);
      }
    }

    return {
      halted: false,
      tenants: tenants.length,
      scanned,
      inserted,
      skipped,
      skipped_tenants: skippedTenants,
    };
  },
);
