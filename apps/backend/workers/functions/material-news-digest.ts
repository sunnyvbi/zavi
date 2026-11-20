
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import {
  isMaterialNewsRolloutEnabled,
  isMaterialNewsOptedIn,
} from "@/agents/material-news/material-news-flag";
import { sendTenantDigest } from "@/services/material-news/digest";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

type TenantRow = { id: string; display_name: string | null };

type TenantOutcome =
  | { status: "skipped"; reason: string }
  | { status: "sent"; count: number };

export async function runDigestForTenant(tenant: TenantRow): Promise<TenantOutcome> {
  if (!(await isMaterialNewsRolloutEnabled(tenant.id))) {
    return { status: "skipped", reason: "rollout_off" };
  }
  if (!(await isMaterialNewsOptedIn(tenant.id))) {
    return { status: "skipped", reason: "opted_out" };
  }
  if (await isFleetHalted()) {
    return { status: "skipped", reason: "fleet_halt" };
  }
  const out = await sendTenantDigest(tenant);
  if (out.status === "sent") return { status: "sent", count: out.count };
  return { status: "skipped", reason: out.reason };
}

export const materialNewsDigestFn = inngest.createFunction(
  { id: "material-news-digest", concurrency: 1 },
  { cron: "0 9 * * *" },
  async ({ step }) => {
    if (isWorkerCronStopped("material-news-digest")) {
      return { halted: false, cron_stopped: true as const, sent: 0, skipped: 0 };
    }
    const halted = await step.run("check-fleet-halt", async () => isFleetHalted());
    if (halted) return { halted: true, sent: 0, skipped: 0 };

    const tenants = await step.run("scan-tenants", async () => {
      const svc = serviceClient();
      const { data, error } = await svc.from("tenants").select("id, display_name");
      if (error) throw new Error(`material-news-digest: tenant scan failed: ${error.message}`);
      return (data ?? []) as TenantRow[];
    });

    let sent = 0;
    let skipped = 0;
    const skippedTenants: Array<{ tenant_id: string; reason: string }> = [];

    for (const tenant of tenants) {
      try {
        const outcome = (await step.run(`tenant-${tenant.id}`, () =>
          runDigestForTenant(tenant),
        )) as TenantOutcome;
        if (outcome.status === "sent") {
          sent++;
          console.info(`[material-news-digest] tenant=${tenant.id} sent to ${outcome.count} recipient(s)`);
        } else {
          skipped++;
          skippedTenants.push({ tenant_id: tenant.id, reason: outcome.reason });
        }
      } catch (e) {
        skipped++;
        skippedTenants.push({ tenant_id: tenant.id, reason: (e as Error).message });
        console.error(`[material-news-digest] tenant=${tenant.id} threw: ${(e as Error).message}`);
      }
    }

    return { halted: false, tenants: tenants.length, sent, skipped, skipped_tenants: skippedTenants };
  },
);
