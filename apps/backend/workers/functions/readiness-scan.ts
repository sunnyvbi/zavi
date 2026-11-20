
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { enqueueWorkItem } from "@/services/agents/work-queue";
import { shouldRunDiscovery } from "@/services/readiness/should-run-discovery";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import {
  sendReadinessDigest,
  type DigestDraft,
  type DigestTenant,
} from "@/services/readiness/digest";
import { DISCOVERY_AGENT_SLUG } from "@/services/tools/discovery/write-anchor";

const MAX_DISPATCH_PER_SCAN = 25;
const DRAFT_LOOKBACK_HOURS = 26;
const SNIPPET_CHARS = 160;

export const readinessScanFn = inngest.createFunction(
  { id: "readiness-scan", concurrency: 1 },
  { cron: "0 6 * * *" },
  async ({ logger }) => {
    if (isWorkerCronStopped("readiness-scan")) {
      logger.info("readiness-scan: skipped — not on the scheduled-work allowlist");
      return { cron_stopped: true as const };
    }
    const svc = serviceClient();

    const { data: tenantRows, error: tErr } = await svc
      .from("tenants")
      .select("id, display_name, slug")
      .eq("kind", "real");
    if (tErr) throw new Error(`readiness-scan tenant read failed: ${tErr.message}`);
    const tenants = (tenantRows ?? []) as Array<{
      id: string;
      display_name: string | null;
      slug: string;
    }>;
    const tenantIds = tenants.map((t) => t.id);
    if (tenantIds.length === 0) return { scanned: 0, dispatched: 0, parked: 0 };

    const nameOf = new Map(tenants.map((t) => [t.id, t.display_name || t.slug]));

    const { data: priorRows } = await svc
      .from("tenant_readiness")
      .select("tenant_id, score")
      .in("tenant_id", tenantIds);
    const priorScore = new Map(
      ((priorRows ?? []) as Array<{ tenant_id: string; score: number }>).map((r) => [
        r.tenant_id,
        r.score,
      ]),
    );

    for (const tenant_id of tenantIds) {
      const { error } = await svc.rpc("compute_tenant_readiness", { p_tenant_id: tenant_id });
      if (error) {
        logger.error(`readiness-scan compute failed for ${tenant_id}: ${error.message}`);
      }
    }

    const { data: snaps, error: sErr } = await svc
      .from("tenant_readiness")
      .select("tenant_id, score, dimensions, last_discovery_at")
      .in("tenant_id", tenantIds);
    if (sErr) throw new Error(`readiness-scan snapshot read failed: ${sErr.message}`);
    const snapshots = (snaps ?? []) as Array<{
      tenant_id: string;
      score: number;
      dimensions: Record<string, unknown>;
      last_discovery_at: string | null;
    }>;

    const { data: conns } = await svc
      .from("tenant_mcp_servers")
      .select("tenant_id, created_at")
      .in("tenant_id", tenantIds);
    const { data: audits } = await svc
      .from("tenant_config_audit")
      .select("tenant_id, created_at")
      .eq("target", "tenant.product_url")
      .in("tenant_id", tenantIds);

    const newestSignal = new Map<string, string>();
    for (const row of [...(conns ?? []), ...(audits ?? [])] as Array<{
      tenant_id: string;
      created_at: string;
    }>) {
      const cur = newestSignal.get(row.tenant_id);
      if (!cur || row.created_at > cur) newestSignal.set(row.tenant_id, row.created_at);
    }

    const today = new Date().toISOString().slice(0, 10);
    let dispatched = 0;
    let parked = 0;

    for (const snap of snapshots) {
      if (dispatched >= MAX_DISPATCH_PER_SCAN) break;

      const decision = shouldRunDiscovery({
        score: snap.score,
        last_discovery_at: snap.last_discovery_at,
        newest_signal_at: newestSignal.get(snap.tenant_id) ?? null,
      });

      if (!decision.run) {
        parked++;
        continue;
      }

      try {
        await enqueueWorkItem({
          tenant_id: snap.tenant_id,
          agent_slug: DISCOVERY_AGENT_SLUG,
          source: "cron",
          dedupe_key: `readiness:${snap.tenant_id}:${today}`,
          payload: { reason: decision.reason, readiness_score: snap.score },
        });
        dispatched++;
        logger.info(
          `readiness-scan dispatched discovery for ${snap.tenant_id} (score ${snap.score}): ${decision.reason}`,
        );
      } catch (e) {
        logger.error(
          `readiness-scan enqueue failed for ${snap.tenant_id}: ${(e as Error).message}`,
        );
      }
    }

    const since = new Date(Date.now() - DRAFT_LOOKBACK_HOURS * 3600 * 1000).toISOString();
    const { data: draftRows } = await svc
      .from("memory_note")
      .select("tenant_id, slug, body_markdown, metadata, updated_at")
      .eq("source", "agent_discovery_inferred")
      .is("superseded_by", null)
      .gte("updated_at", since)
      .in("tenant_id", tenantIds);

    const drafts: DigestDraft[] = (
      (draftRows ?? []) as Array<{
        tenant_id: string;
        slug: string;
        body_markdown: string | null;
        metadata: Record<string, unknown> | null;
      }>
    ).map((r) => {
      const d = (r.metadata?.discovery ?? {}) as Record<string, unknown>;
      const body = (r.body_markdown ?? "").replace(/\s+/g, " ").trim();
      return {
        tenant_name: nameOf.get(r.tenant_id) ?? r.tenant_id.slice(0, 8),
        canonical_slug: r.slug.replace(/__inferred$/, ""),
        confidence: String(d.confidence ?? "low"),
        snippet: body.length > SNIPPET_CHARS ? `${body.slice(0, SNIPPET_CHARS)}...` : body,
      };
    });

    const digestTenants: DigestTenant[] = snapshots.map((s) => ({
      tenant_id: s.tenant_id,
      name: nameOf.get(s.tenant_id) ?? s.tenant_id.slice(0, 8),
      prev_score: priorScore.has(s.tenant_id) ? (priorScore.get(s.tenant_id) as number) : null,
      score: s.score,
      dims: s.dimensions ?? {},
    }));

    const mail = await sendReadinessDigest({
      tenants: digestTenants,
      drafts,
      dispatched,
      parked,
    });

    logger.info(
      `readiness-scan: ${snapshots.length} scanned, ${dispatched} dispatched, ${parked} parked, ` +
        `${drafts.length} drafts, digest ${mail.sent ? "sent" : `skipped (${mail.reason})`}`,
    );
    return {
      scanned: snapshots.length,
      dispatched,
      parked,
      drafts: drafts.length,
      digest_sent: mail.sent,
    };
  },
);
