
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient } from "@/services/tenant-client";

const TABLE = "creator_notifications";
const LIST_LIMIT = 30;

const ReadBody = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }),
]);

export type BusinessNotification = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link_path: string | null;
  order_id: string | null;
  read_at: string | null;
  created_at: string;
};

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export async function getBusinessNotifications(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const client = tenantClient(asTenantId(auth.tenant_id));
  const [list, unread] = await Promise.all([
    client
      .from(TABLE)
      .select("id, kind, title, body, link_path, order_id, read_at, created_at")
      .eq("recipient_kind", "tenant")
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT),
    client
      .from(TABLE)
      .select("id", { count: "exact", head: true })
      .eq("recipient_kind", "tenant")
      .is("read_at", null),
  ]);
  if (list.error || unread.error) {
    console.error(`[humans/notifications] read failed: ${(list.error ?? unread.error)?.message}`);
    fail(res, 500, "notifications_read_failed", "Notifications did not load.");
    return;
  }
  res.json({
    notifications: (list.data ?? []) as BusinessNotification[],
    unread: unread.count ?? 0,
  });
}

export async function postBusinessNotificationsRead(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = ReadBody.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, "validation", "Send { ids: [...] } or { all: true }.");
    return;
  }
  let q = tenantClient(asTenantId(auth.tenant_id))
    .from(TABLE)
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_kind", "tenant")
    .is("read_at", null);
  if ("ids" in parsed.data) q = q.in("id", parsed.data.ids);
  const { error } = await q;
  if (error) {
    console.error(`[humans/notifications] mark read failed: ${error.message}`);
    fail(res, 500, "notifications_write_failed", "Could not mark those as read.");
    return;
  }
  res.json({ ok: true });
}
