
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type Row = {
  tenant_id: string;
  tenant: string;
  status: string;
  platform: string;
  source: string;
  atoms: number;
  transcript_chars: number;
  scheduled_for: string | null;
  created_at: string | null;
};

function platformFromUrl(url: string | null): string {
  if (!url) return "—";
  const u = url.toLowerCase();
  if (u.includes("zoom.")) return "zoom";
  if (u.includes("meet.google")) return "google meet";
  if (u.includes("teams.microsoft") || u.includes("teams.live")) return "teams";
  if (u.includes("webex.")) return "webex";
  return "other";
}

export async function staffMeetingsOps(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/meetings-ops: cross-tenant staff read-only board");

  const [bots, tenants] = await Promise.all([
    sb
      .from("meeting_bots")
      .select("tenant_id, provider, meeting_url, status, source, atoms_count, transcript_chars, scheduled_for, created_at")
      .order("created_at", { ascending: false })
      .limit(200),
    sb.from("tenants").select("id, slug, display_name"),
  ]);

  const nameById = new Map<string, string>();
  for (const t of (tenants.data ?? []) as Array<{ id: string; slug: string | null; display_name: string | null }>) {
    nameById.set(t.id, t.display_name || t.slug || t.id.slice(0, 8));
  }

  type Bot = {
    tenant_id: string;
    provider: string | null;
    meeting_url: string | null;
    status: string | null;
    source: string | null;
    atoms_count: number | null;
    transcript_chars: number | null;
    scheduled_for: string | null;
    created_at: string | null;
  };

  const rows: Row[] = ((bots.data ?? []) as Bot[]).map((b) => {
    const platform = platformFromUrl(b.meeting_url);
    return {
      tenant_id: b.tenant_id,
      tenant: nameById.get(b.tenant_id) ?? b.tenant_id.slice(0, 8),
      status: b.status ?? "unknown",
      platform: platform === "other" ? b.provider || "other" : platform,
      source: b.source ?? "scheduled",
      atoms: typeof b.atoms_count === "number" ? b.atoms_count : 0,
      transcript_chars: typeof b.transcript_chars === "number" ? b.transcript_chars : 0,
      scheduled_for: b.scheduled_for,
      created_at: b.created_at,
    };
  });

  res.json({
    meetings: rows,
    summary: {
      total: rows.length,
      failed: rows.filter((r) => r.status === "failed").length,
      in_progress: rows.filter((r) => ["scheduled", "joining", "in_call", "processing"].includes(r.status)).length,
    },
  });
}
