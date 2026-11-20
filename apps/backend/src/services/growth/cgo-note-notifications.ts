import { asTenantId, fleetSweepClient, tenantClient } from "@/services/tenant-client";

export const REQUEUE_AFTER_MS = 6 * 3_600_000;

type PendingNote = { id: string; run_id: string | null; notification_key: string | null; notified: boolean | null; queued_at?: string | null };

export function noteEventId(note: { id: string; run_id: string | null; queued_at?: string | null }): string {
  const base = `cgo-note-email:${note.run_id ?? `note:${note.id}`}`;
  const at = note.queued_at ? Date.parse(note.queued_at) : NaN;
  return Number.isFinite(at) ? `${base}:${at}` : base;
}

export async function queueCgoNote(tenant_id: string, note: PendingNote, now: Date = new Date()): Promise<void> {
  if (!note.notification_key || note.notified === true) return;
  const { inngest } = await import("@/../workers/client");
  const ref = note.run_id ? { run_id: note.run_id } : { note_id: note.id };
  await inngest.send({ id: noteEventId(note), name: "cgo/note.email", data: { ...ref, tenant_id } });
  const { error } = await tenantClient(asTenantId(tenant_id)).from("cgo_notes").update({ queued_at: now.toISOString() }).eq("tenant_id", tenant_id).eq("id", note.id);
  if (error) throw new Error(`cgo notification queue mark failed: ${error.message}`);
}

export async function flushPendingCgoNotes(tenant_id: string, now: Date = new Date()): Promise<number> {
  const stale = new Date(now.getTime() - REQUEUE_AFTER_MS).toISOString();
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("cgo_notes")
    .select("id, run_id, notification_key, notified, queued_at")
    .eq("tenant_id", tenant_id)
    .eq("notified", false)
    .not("notification_key", "is", null)
    .or(`queued_at.is.null,queued_at.lt.${stale}`)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(`cgo pending notifications read failed: ${error.message}`);
  const notes = (data ?? []) as PendingNote[];
  for (const note of notes) await queueCgoNote(tenant_id, note, now);
  return notes.length;
}

export async function tenantsWithPendingCgoNotes(): Promise<string[]> {
  const { data, error } = await fleetSweepClient("cgo pending notifications")
    .from("cgo_notes")
    .select("tenant_id")
    .eq("notified", false)
    .not("notification_key", "is", null)
    .or(`queued_at.is.null,queued_at.lt.${new Date(Date.now() - REQUEUE_AFTER_MS).toISOString()}`)
    .limit(200);
  if (error) throw new Error(`cgo pending notification tenants read failed: ${error.message}`);
  return [...new Set(((data ?? []) as Array<{ tenant_id: string }>).map((n) => n.tenant_id))];
}

export async function flushAllPendingCgoNotes(): Promise<{ tenants: number; queued: number; failed: number }> {
  let queued = 0;
  let failed = 0;
  const tenants = await tenantsWithPendingCgoNotes();
  for (const t of tenants) {
    try {
      queued += await flushPendingCgoNotes(t);
    } catch (e) {
      failed++;
      console.warn(`[cgo-note-notifications] pending notes for ${t}: ${(e as Error).message}`);
    }
  }
  return { tenants: tenants.length, queued, failed };
}
