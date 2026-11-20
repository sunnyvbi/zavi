
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type Entry = {
  at: string;
  actor: string;
  action: string;
  target: string | null;
  tenant_id: string | null;
  source: "staff" | "admin_task" | "tenant_config";
  on_behalf?: boolean;
};

export async function staffAuditLog(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/audit-log: cross-tenant staff read-only board");
  const LIM = 150;

  const [staff, admin, config] = await Promise.all([
    sb
      .from("staff_audit_log")
      .select("actor_email, action, target_table, target_id, tenant_id, created_at")
      .order("created_at", { ascending: false })
      .limit(LIM),
    sb
      .from("admin_action_log")
      .select("staff_email, action, target, tenant_id, on_behalf, created_at")
      .order("created_at", { ascending: false })
      .limit(LIM),
    sb
      .from("tenant_config_audit")
      .select("actor_user_id, action, target, prev_value, next_value, tenant_id, created_at")
      .order("created_at", { ascending: false })
      .limit(LIM),
  ]);

  const entries: Entry[] = [];

  for (const r of (staff.data ?? []) as Array<{
    actor_email: string; action: string; target_table: string | null; target_id: string | null; tenant_id: string | null; created_at: string;
  }>) {
    entries.push({
      at: r.created_at,
      actor: r.actor_email,
      action: r.action,
      target: [r.target_table, r.target_id].filter(Boolean).join(" · ") || null,
      tenant_id: r.tenant_id,
      source: "staff",
    });
  }
  for (const r of (admin.data ?? []) as Array<{
    staff_email: string; action: string; target: string | null; tenant_id: string | null; on_behalf: boolean; created_at: string;
  }>) {
    entries.push({
      at: r.created_at,
      actor: r.staff_email,
      action: r.action,
      target: r.target,
      tenant_id: r.tenant_id,
      source: "admin_task",
      on_behalf: r.on_behalf,
    });
  }
  for (const r of (config.data ?? []) as Array<{
    actor_user_id: string; action: string; target: string; prev_value: string | null; next_value: string | null; tenant_id: string | null; created_at: string;
  }>) {
    const delta = r.prev_value != null || r.next_value != null ? ` (${r.prev_value ?? "∅"} → ${r.next_value ?? "∅"})` : "";
    entries.push({
      at: r.created_at,
      actor: r.actor_user_id.slice(0, 8),
      action: r.action,
      target: `${r.target}${delta}`,
      tenant_id: r.tenant_id,
      source: "tenant_config",
    });
  }

  entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  res.json({ entries: entries.slice(0, 200) });
}
