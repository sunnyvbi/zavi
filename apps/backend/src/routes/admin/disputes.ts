
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type Entry = {
  at: string;
  event_id: string;
  type: string;
  tenant_id: string | null;
  amount: string | null;
  status: string | null;
};

export async function staffDisputes(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/disputes: cross-tenant staff read-only board");

  const { data, error } = await sb
    .from("stripe_billing_events")
    .select("event_id, type, received_at")
    .ilike("type", "charge.dispute%")
    .order("received_at", { ascending: false })
    .limit(200);

  if (error) {
    res.status(500).json({ error: { message: error.message } });
    return;
  }

  const entries: Entry[] = ((data ?? []) as Array<{
    event_id: string;
    type: string | null;
    received_at: string;
  }>).map((r) => ({
    at: r.received_at,
    event_id: r.event_id,
    type: r.type ?? "charge.dispute",
    tenant_id: null,
    amount: null,
    status: null,
  }));

  res.json({ entries });
}
