
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export const PROP_WHITELIST: Record<string, string[]> = {
  "connector.connected": ["slug"],
  "connector.connect_failed": ["slug", "reason"],
  "deliverable.produced": ["mime", "bytes"],
};

type EventRow = {
  id: number;
  tenant_id: string;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  verb: string;
  object_type: string | null;
  object_id: string | null;
  source: string;
  props: Record<string, unknown> | null;
  confidence: string;
  run_id: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function staffActivity(req: Request, res: Response): Promise<void> {
  assertStaff(req);

  const tenantId = req.query.tenant_id ? String(req.query.tenant_id) : null;
  if (tenantId && !UUID_RE.test(tenantId)) {
    res.status(400).json({ error: { code: "invalid_tenant_id", message: "tenant_id must be a UUID" } });
    return;
  }
  const verb = req.query.verb ? String(req.query.verb).slice(0, 80) : null;
  const rawLimit = Number.parseInt(String(req.query.limit ?? "100"), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, rawLimit)) : 100;

  const sb = serviceClient();
  let q = sb
    .from("activity_events")
    .select("id, tenant_id, occurred_at, actor_type, actor_id, verb, object_type, object_id, source, props, confidence, run_id")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (tenantId) q = q.eq("tenant_id", tenantId);
  if (verb) q = q.eq("verb", verb);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ error: { code: "activity_failed", message: error.message } });
    return;
  }

  const rows = (data ?? []) as EventRow[];

  let slugById = new Map<string, string>();
  if (!tenantId && rows.length > 0) {
    const ids = [...new Set(rows.map((r) => r.tenant_id))];
    const { data: tData } = await sb.from("tenants").select("id, slug").in("id", ids);
    slugById = new Map(((tData ?? []) as Array<{ id: string; slug: string }>).map((t) => [t.id, t.slug]));
  }

  const events = rows.map((r) => {
    const allow = PROP_WHITELIST[r.verb] ?? [];
    const detail: Record<string, unknown> = {};
    for (const k of allow) {
      const v = r.props?.[k];
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") detail[k] = v;
    }
    const safeObjectId = r.verb.startsWith("connector.") ? r.object_id : null;
    return {
      id: r.id,
      tenant_id: r.tenant_id,
      tenant_slug: slugById.get(r.tenant_id) ?? null,
      occurred_at: r.occurred_at,
      actor_type: r.actor_type,
      verb: r.verb,
      object_type: r.object_type,
      object_id: safeObjectId,
      source: r.source,
      confidence: r.confidence,
      run_id: r.run_id,
      detail,
    };
  });

  res.json({ mode: tenantId ? "tenant" : "firehose", count: events.length, events });
}
