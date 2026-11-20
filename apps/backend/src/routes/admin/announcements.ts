
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type Entry = {
  at: string;
  kind: string;
  audience: string | null;
  summary: string | null;
  status: string | null;
  count: number | null;
  source: "digest" | "comms";
};

export async function staffAnnouncements(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/announcements: cross-tenant staff read-only board");
  const LIM = 150;

  const [digest, comms] = await Promise.all([
    sb
      .from("digest_send_audit")
      .select("created_at, tenant_id, source_worker, subject_hash, guard_verdict")
      .order("created_at", { ascending: false })
      .limit(LIM),
    sb
      .from("comms_send_log")
      .select("sent_at, tenant_id, channel")
      .order("sent_at", { ascending: false })
      .limit(500),
  ]);

  const entries: Entry[] = [];

  for (const r of (digest.data ?? []) as Array<{
    created_at: string; tenant_id: string | null; source_worker: string | null; subject_hash: string | null; guard_verdict: string | null;
  }>) {
    entries.push({
      at: r.created_at,
      kind: r.source_worker ?? "digest",
      audience: r.tenant_id ?? null,
      summary: r.subject_hash ? `subject #${String(r.subject_hash).slice(0, 10)}` : null,
      status: r.guard_verdict ?? null,
      count: null,
      source: "digest",
    });
  }

  const agg = new Map<string, { at: string; tenant_id: string | null; channel: string; count: number }>();
  for (const r of (comms.data ?? []) as Array<{
    sent_at: string | null; tenant_id: string | null; channel: string | null;
  }>) {
    if (!r.sent_at) continue;
    const day = String(r.sent_at).slice(0, 10);
    const channel = r.channel ?? "unknown";
    const key = `${r.tenant_id ?? ""}|${channel}|${day}`;
    const cur = agg.get(key);
    if (cur) {
      cur.count += 1;
      if (r.sent_at > cur.at) cur.at = r.sent_at;
    } else {
      agg.set(key, { at: r.sent_at, tenant_id: r.tenant_id ?? null, channel, count: 1 });
    }
  }
  for (const g of agg.values()) {
    entries.push({
      at: g.at,
      kind: `comms · ${g.channel}`,
      audience: g.tenant_id,
      summary: null,
      status: "sent",
      count: g.count,
      source: "comms",
    });
  }

  entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  res.json({ entries: entries.slice(0, 150) });
}
