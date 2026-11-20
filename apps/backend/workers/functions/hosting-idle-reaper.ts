
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import {
  planReap,
  HUMAN_TRIGGERS,
  IDLE_SUSPEND_DAYS,
  type HostingRow,
} from "@/services/provisioning/hosting-idle-reaper";

const RENDER = "https://api.render.com";

function isAccepted(status: number): boolean {
  return status === 200 || status === 202 || status === 204;
}

function latestIso(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (best === null || new Date(v).getTime() > new Date(best).getTime()) best = v;
  }
  return best;
}

export const hostingIdleReaperFn = inngest.createFunction(
  { id: "hosting-idle-reaper" },
  { cron: "0 5 * * *" },
  async ({ logger }) => {
    const token = process.env.RENDER_API_KEY;
    if (!token) {
      logger.warn("hosting-idle-reaper: RENDER_API_KEY not configured — skipping");
      return { skipped: "no_render_key" };
    }
    const sb = serviceClient();

    const { data: resources, error: resErr } = await sb
      .from("tenant_resources")
      .select("tenant_id, external_ref")
      .eq("resource_kind", "hosting")
      .eq("provider", "render")
      .eq("status", "ready");
    if (resErr) {
      logger.error(`hosting-idle-reaper: tenant_resources query failed: ${resErr.message}`);
      return { error: "query_failed" };
    }

    const byService = new Map<string, string>();
    for (const r of resources ?? []) {
      const ref = (r.external_ref ?? {}) as { render_service_id?: string };
      if (ref.render_service_id) byService.set(ref.render_service_id, r.tenant_id);
    }
    if (byService.size === 0) return { considered: 0 };

    const rows: HostingRow[] = [];
    for (const [serviceId, tenantId] of byService) {
      const res = await fetch(`${RENDER}/v1/services/${serviceId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (res.status === 404) continue;
      if (!res.ok) {
        logger.warn(`hosting-idle-reaper: GET ${serviceId} → ${res.status}`);
        continue;
      }
      const svc = (await res.json()) as {
        suspended?: string;
        suspenders?: string[];
        serviceDetails?: { plan?: string };
      };

      const { data: runs } = await sb
        .from("agent_runs")
        .select("enqueued_at")
        .eq("tenant_id", tenantId)
        .in("trigger", HUMAN_TRIGGERS as unknown as string[])
        .order("enqueued_at", { ascending: false })
        .limit(1);

      const { data: builds, error: buildsErr } = await sb
        .from("conductor_runs")
        .select("created_at")
        .eq("tenant_id", tenantId)
        .eq("kind", "build_app")
        .order("created_at", { ascending: false })
        .limit(1);
      if (buildsErr) {
        logger.warn(`hosting-idle-reaper: build lookup for ${serviceId} failed: ${buildsErr.message}`);
        continue;
      }

      const { data: owned, error: ownedErr } = await sb
        .from("tenant_custom_domains")
        .select("hostname, status")
        .eq("render_service_id", serviceId)
        .eq("status", "verified")
        .limit(1);
      if (ownedErr) {
        logger.warn(`hosting-idle-reaper: domain lookup for ${serviceId} failed: ${ownedErr.message}`);
        continue;
      }

      const { data: dbRows, error: dbErr } = await sb
        .from("tenant_resources")
        .select("status")
        .eq("tenant_id", tenantId)
        .eq("resource_kind", "db");
      if (dbErr) {
        logger.warn(`hosting-idle-reaper: db lookup for ${serviceId} failed: ${dbErr.message}`);
        continue;
      }

      rows.push({
        tenant_id: tenantId,
        render_service_id: serviceId,
        suspended: svc.suspended ?? "not_suspended",
        suspenders: svc.suspenders ?? [],
        plan: svc.serviceDetails?.plan,
        last_human_at: latestIso(runs?.[0]?.enqueued_at, builds?.[0]?.created_at),
        has_own_domain: (owned ?? []).length > 0,
        has_db:
          dbRows && dbRows.length > 0
            ? !dbRows.every((d) => d.status === "torn_down" || d.status === "teardown")
            : undefined,
      });
    }

    const plan = planReap(rows);

    let suspended = 0;
    let resumed = 0;
    for (const [action, list] of [
      ["suspend", plan.suspend],
      ["resume", plan.resume],
    ] as const) {
      for (const r of list) {
        const res = await fetch(
          `${RENDER}/v1/services/${r.render_service_id}/${action}`,
          { method: "POST", headers: { Authorization: `Bearer ${token}` } },
        );
        if (isAccepted(res.status)) {
          action === "suspend" ? suspended++ : resumed++;
        } else {
          logger.warn(
            `hosting-idle-reaper: ${action} ${r.render_service_id} → ${res.status}`,
          );
        }
        await logEvent({
          level: isAccepted(res.status) ? "info" : "warn",
          source: "hosting-idle-reaper",
          code: `hosting_${action}`,
          meta: { code: res.status },
        });
      }
    }

    logger.info(
      `hosting-idle-reaper: considered=${rows.length} suspended=${suspended} ` +
        `resumed=${resumed} skipped=${plan.skipped.length} idle_days=${IDLE_SUSPEND_DAYS}`,
    );
    return { considered: rows.length, suspended, resumed, skipped: plan.skipped.length };
  },
);
