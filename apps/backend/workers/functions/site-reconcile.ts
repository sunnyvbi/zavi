
import { inngest } from "../client";
import type { SitePointerLedger, SiteStore } from "@/services/sites/contract";
import { createSitePublisher, type SitePublisherImpl } from "@/services/hosting/site-publish";
import { siteStore } from "@/services/sites/store";
import { sitePointerLedger } from "@/services/sites/pointer-ledger";
import { resolveProvisionOrg } from "@/services/provisioning/provision-org";
import { staticHostingConfig } from "@/services/hosting/static-publish";
import { SITE_POINTER_CONCURRENCY } from "./site-activate";

export const SITE_RECONCILE_EVENT = "site/reconcile" as const;
export const SITE_RECONCILE_BATCH = 200;
export const SITE_RECONCILE_SETTLE_MS = 5 * 60 * 1000;
export const SITE_VERIFY_DELAY_MS = 60 * 1000;

type ReconcileData = { tenant_id: string; site_id: string; source?: "verify" };
type SendReconcile = (events: Array<{ id: string; name: typeof SITE_RECONCILE_EVENT; data: ReconcileData; ts?: number }>) => Promise<unknown>;

export async function requestSiteVerify(
  input: { tenant_id: string; site_id: string; version: number },
  send: SendReconcile = (events) => inngest.send(events),
  now: () => number = Date.now,
): Promise<void> {
  await send([
    {
      id: `site-verify:${input.site_id}:${input.version}`,
      name: SITE_RECONCILE_EVENT,
      data: { tenant_id: input.tenant_id, site_id: input.site_id, source: "verify" },
      ts: now() + SITE_VERIFY_DELAY_MS,
    },
  ]);
}

export function sitePointerSweepAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "production" && staticHostingConfig(env).ok;
}

export type EnqueueDeps = {
  ledger: Pick<SitePointerLedger, "driftBatch">;
  send: SendReconcile;
  now: () => number;
  configured: () => boolean;
};

export async function enqueueSitePointerRepairs(deps: EnqueueDeps): Promise<{ enqueued: number; skipped?: string }> {
  if (!deps.configured()) return { enqueued: 0, skipped: "no_static_hosting" };
  const now = deps.now();
  const rows = await deps.ledger.driftBatch(new Date(now - SITE_RECONCILE_SETTLE_MS).toISOString(), SITE_RECONCILE_BATCH);
  if (!rows.length) return { enqueued: 0 };
  const hour = Math.floor(now / 3_600_000);
  await deps.send(
    rows.map((r) => ({ id: `site-reconcile:${r.site_id}:${hour}`, name: SITE_RECONCILE_EVENT, data: { tenant_id: r.tenant_id, site_id: r.site_id } })),
  );
  return { enqueued: rows.length };
}

export type SiteReconcileDeps = {
  store: Pick<SiteStore, "get">;
  reconcile: SitePublisherImpl["reconcile"];
  org: () => string;
};

export async function handleSiteReconcile(
  raw: unknown,
  deps: SiteReconcileDeps,
): Promise<{ outcome: string } | { skipped: "bad_request" | "other_env" | "gone" }> {
  const d = (raw ?? {}) as Record<string, unknown>;
  const tenant_id = typeof d.tenant_id === "string" ? d.tenant_id : "";
  const site_id = typeof d.site_id === "string" ? d.site_id : "";
  if (!tenant_id || !site_id) return { skipped: "bad_request" };
  const site = await deps.store.get(tenant_id, site_id);
  if (!site) return { skipped: "gone" };
  const owner = (site.github_full_name ?? "").split("/")[0]?.trim().toLowerCase();
  if (owner && owner !== deps.org().trim().toLowerCase()) return { skipped: "other_env" };
  const r = await deps.reconcile({ tenant_id, site_id, source: d.source === "verify" ? "verify" : "sweep" });
  return { outcome: r.outcome };
}

let _publisher: SitePublisherImpl | null = null;
function publisher(): SitePublisherImpl {
  return (_publisher ??= createSitePublisher({ store: siteStore() }));
}

export function realEnqueueDeps(): EnqueueDeps {
  return {
    ledger: sitePointerLedger(),
    send: (events) => inngest.send(events),
    now: () => Date.now(),
    configured: () => sitePointerSweepAllowed(),
  };
}

export const siteReconcileFn = inngest.createFunction(
  { id: "site-reconcile", retries: 2, concurrency: SITE_POINTER_CONCURRENCY },
  { event: SITE_RECONCILE_EVENT },
  async ({ event, step }) =>
    step.run("reconcile", () =>
      handleSiteReconcile(event.data, {
        store: siteStore(),
        reconcile: (input) => publisher().reconcile(input),
        org: () => resolveProvisionOrg(),
      }),
    ),
);
