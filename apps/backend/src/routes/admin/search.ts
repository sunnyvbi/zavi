
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type Kind = "tenant" | "run" | "decision";
type Result = { kind: Kind; id: string; label: string; tenant_id: string; href: string };

const CAP = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function staffGlobalSearch(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) {
    res.json({ results: [] });
    return;
  }

  const sb = staffCrossTenantClient("admin/search: cross-tenant staff read-only board");
  const isUuid = UUID_RE.test(q);
  const safe = q.replace(/[,()]/g, "").trim();
  const like = `%${safe}%`;

  const [tenantsByText, tenantById, runById, decisionById] = await Promise.all([
    safe.length >= 2
      ? sb
          .from("tenants")
          .select("id, slug, display_name")
          .or(`slug.ilike.${like},display_name.ilike.${like}`)
          .limit(CAP)
      : Promise.resolve({ data: [] as TenantRow[] }),
    isUuid
      ? sb.from("tenants").select("id, slug, display_name").eq("id", q).limit(1)
      : Promise.resolve({ data: [] as TenantRow[] }),
    isUuid
      ? sb.from("agent_runs").select("id, tenant_id, agent_slug, status, enqueued_at").eq("id", q).limit(1)
      : Promise.resolve({ data: [] as RunRow[] }),
    isUuid
      ? sb.from("decisions").select("id, tenant_id, decision_class, status").eq("id", q).limit(1)
      : Promise.resolve({ data: [] as DecisionRow[] }),
  ]);

  const results: Result[] = [];
  const seenTenants = new Set<string>();

  const pushTenant = (t: TenantRow): void => {
    if (!t?.id || seenTenants.has(t.id)) return;
    seenTenants.add(t.id);
    results.push({
      kind: "tenant",
      id: t.id,
      label: t.display_name || t.slug || t.id.slice(0, 8),
      tenant_id: t.id,
      href: `/tenants/${t.id}`,
    });
  };

  for (const t of (tenantById.data ?? []) as TenantRow[]) pushTenant(t);
  for (const t of (tenantsByText.data ?? []) as TenantRow[]) pushTenant(t);

  for (const r of (runById.data ?? []) as RunRow[]) {
    if (!r?.id) continue;
    results.push({
      kind: "run",
      id: r.id,
      label: `${r.agent_slug ?? "run"} · ${r.status ?? "?"}`,
      tenant_id: r.tenant_id,
      href: `/runs/${r.id}`,
    });
  }

  for (const d of (decisionById.data ?? []) as DecisionRow[]) {
    if (!d?.id) continue;
    results.push({
      kind: "decision",
      id: d.id,
      label: `${d.decision_class ?? "decision"} · ${d.status ?? "?"}`,
      tenant_id: d.tenant_id,
      href: `/decisions/${d.id}`,
    });
  }

  res.json({ results: results.slice(0, CAP) });
}

type TenantRow = { id: string; slug: string | null; display_name: string | null };
type RunRow = { id: string; tenant_id: string; agent_slug: string | null; status: string | null; enqueued_at: string | null };
type DecisionRow = { id: string; tenant_id: string; decision_class: string | null; status: string | null };
