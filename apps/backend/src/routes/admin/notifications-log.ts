
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type Entry = {
  at: string;
  channel: "email" | "slack";
  tenant_id: string | null;
  subject_or_summary: string | null;
  status: string;
};

export async function staffNotificationsLog(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/notifications-log: cross-tenant staff read-only board");
  const LIM = 150;

  const [email, slack] = await Promise.all([
    sb
      .from("email_messages")
      .select("subject, to_addresses, tenant_id, created_at")
      .eq("direction", "out")
      .order("created_at", { ascending: false })
      .limit(LIM),
    sb
      .from("slack_outbox")
      .select("kind, body, status, tenant_id, enqueued_at, sent_at")
      .order("enqueued_at", { ascending: false })
      .limit(LIM),
  ]);

  const entries: Entry[] = [];

  for (const r of (email.data ?? []) as Array<{
    subject: string | null; to_addresses: string[] | null; tenant_id: string | null; created_at: string;
  }>) {
    const to = (r.to_addresses ?? []).filter(Boolean).join(", ");
    const summary = [r.subject, to ? `→ ${to}` : ""].filter(Boolean).join(" ") || null;
    entries.push({
      at: r.created_at,
      channel: "email",
      tenant_id: r.tenant_id,
      subject_or_summary: summary,
      status: "sent",
    });
  }
  for (const r of (slack.data ?? []) as Array<{
    kind: string | null; body: string | null; status: string | null; tenant_id: string | null; enqueued_at: string; sent_at: string | null;
  }>) {
    const body = (r.body ?? "").replace(/\s+/g, " ").trim();
    const summary = [r.kind, body ? body.slice(0, 120) : ""].filter(Boolean).join(" · ") || null;
    entries.push({
      at: r.sent_at ?? r.enqueued_at,
      channel: "slack",
      tenant_id: r.tenant_id,
      subject_or_summary: summary,
      status: r.status ?? "pending",
    });
  }

  entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  res.json({ entries: entries.slice(0, 200) });
}
