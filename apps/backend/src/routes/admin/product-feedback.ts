
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { writeStaffAuditStrict } from "@/services/staff/audit";
import { sendFeedbackClosedEmail } from "@/email/sendFeedbackClosedEmail";

const CLIENT_REASON = "admin/product-feedback: staff triage of product feedback across companies";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Status = "received" | "working" | "done" | "wont_do";
const CLOSED: ReadonlySet<Status> = new Set(["done", "wont_do"]);

type Row = {
  id: string;
  tenant_id: string;
  created_by: string | null;
  body: string;
  attachments: unknown;
  source: string;
  created_at: string;
  status: Status;
  staff_note: string | null;
  status_updated_at: string | null;
};

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

async function currentSenderEmail(
  sb: ReturnType<typeof staffCrossTenantClient>,
  tenantId: string,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const { data: member } = await sb
    .from("tenant_users")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!member) return null;
  const { data, error } = await sb.auth.admin.getUserById(userId);
  if (error || !data?.user?.email) return null;
  return data.user.email;
}

export async function staffProductFeedbackList(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);

  try {
    await writeStaffAuditStrict({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "staff.product_feedback.list",
      target_table: "tenant_feedback",
    });
  } catch {
    return fail(res, 503, "audit_unavailable", "Could not record this read, so the feedback stays hidden. Try again.");
  }

  const sb = staffCrossTenantClient(CLIENT_REASON);
  const { data, error } = await sb
    .from("tenant_feedback")
    .select("id, tenant_id, created_by, body, attachments, source, created_at, status, staff_note, status_updated_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return fail(res, 500, "read_failed", error.message);
  const rows = (data ?? []) as Row[];

  const tenantIds = [...new Set(rows.map((r) => r.tenant_id))];
  const names = new Map<string, string>();
  if (tenantIds.length > 0) {
    const { data: tenants } = await sb.from("tenants").select("id, display_name").in("id", tenantIds);
    for (const t of (tenants ?? []) as { id: string; display_name: string | null }[]) {
      names.set(t.id, t.display_name ?? t.id);
    }
  }

  const senders = new Map<string, string | null>();
  for (const r of rows) {
    const key = `${r.tenant_id}:${r.created_by ?? ""}`;
    if (!senders.has(key)) senders.set(key, await currentSenderEmail(sb, r.tenant_id, r.created_by));
  }

  res.json({
    feedback: rows.map((r) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      company: names.get(r.tenant_id) ?? r.tenant_id,
      sender: senders.get(`${r.tenant_id}:${r.created_by ?? ""}`) ?? "(user removed)",
      body: r.body,
      attachment_count: Array.isArray(r.attachments) ? r.attachments.length : 0,
      source: r.source,
      created_at: r.created_at,
      status: r.status,
      staff_note: r.staff_note,
      status_updated_at: r.status_updated_at,
    })),
  });
}

const PatchBody = z
  .object({
    status: z.enum(["received", "working", "done", "wont_do"]),
    staff_note: z.string().max(2000).nullable().optional(),
  })
  .strict();

export async function staffProductFeedbackUpdate(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return fail(res, 404, "not_found", "No such feedback.");

  const parsed = PatchBody.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "invalid_body", "Pick a status; the note is up to 2000 characters.");
  const nextStatus = parsed.data.status;
  const nextNote = parsed.data.staff_note?.trim() || null;

  const sb = staffCrossTenantClient(CLIENT_REASON);
  const { data: before, error: readErr } = await sb
    .from("tenant_feedback")
    .select("id, tenant_id, created_by, body, status, staff_note")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return fail(res, 500, "read_failed", readErr.message);
  if (!before) return fail(res, 404, "not_found", "No such feedback.");
  const old = before as Pick<Row, "id" | "tenant_id" | "created_by" | "body" | "status" | "staff_note">;

  const changed = old.status !== nextStatus || (old.staff_note ?? null) !== nextNote;
  if (!changed) {
    res.json({ ok: true, changed: false, emailed: false });
    return;
  }

  try {
    await writeStaffAuditStrict({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "staff.product_feedback.update",
      target_table: "tenant_feedback",
      target_id: old.id,
      tenant_id: old.tenant_id,
      meta: { from: old.status, to: nextStatus, note_changed: (old.staff_note ?? null) !== nextNote },
    });
  } catch {
    return fail(res, 503, "audit_unavailable", "Could not record this change, so it was not saved. Try again.");
  }

  const { error: updErr } = await sb
    .from("tenant_feedback")
    .update({ status: nextStatus, staff_note: nextNote, status_updated_at: new Date().toISOString() })
    .eq("id", old.id)
    .eq("tenant_id", old.tenant_id);
  if (updErr) return fail(res, 500, "update_failed", updErr.message);

  let emailed = false;
  if (CLOSED.has(nextStatus) && old.status !== nextStatus) {
    const to = await currentSenderEmail(sb, old.tenant_id, old.created_by);
    if (to) {
      try {
        await sendFeedbackClosedEmail({ to, status: nextStatus as "done" | "wont_do", body: old.body, note: nextNote });
        emailed = true;
      } catch (e) {
        console.warn(`[product-feedback] close email failed: ${e instanceof Error ? e.message : "unknown"}`.slice(0, 200));
      }
    }
  }

  res.json({ ok: true, changed: true, emailed });
}
