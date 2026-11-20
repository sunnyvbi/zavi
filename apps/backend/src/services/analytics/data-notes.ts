
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { METRIC_CATALOG } from "@/services/analytics/metric-registry";

export const DATA_NOTE_MAX_CHARS = 1000;
export type DataNote = {
  id: string;
  metric_id: string | null;
  note_text: string;
  created_by: string | null;
  created_at: string;
};

const COLUMNS = "id, metric_id, note_text, created_by, created_at";

export async function recordDataNote(
  tenant_id: string,
  input: { metric_id: string | null; note_text: string; created_by: string | null },
): Promise<DataNote> {
  const note_text = input.note_text.trim();
  if (!note_text) throw new Error("data note text is empty");
  if (input.metric_id !== null && !METRIC_CATALOG[input.metric_id]) {
    throw new Error(`unknown catalog metric ${input.metric_id}`);
  }
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_data_notes")
    .insert({
      metric_id: input.metric_id,
      note_text: note_text.slice(0, DATA_NOTE_MAX_CHARS),
      created_by: input.created_by,
    })
    .select(COLUMNS)
    .single();
  if (error || !data) throw new Error(`data note not saved: ${error?.message ?? "no row"}`);
  return data as DataNote;
}

export async function listActiveDataNotes(tenant_id: string, metric_id?: string): Promise<DataNote[]> {
  let q = tenantClient(asTenantId(tenant_id))
    .from("tenant_data_notes")
    .select(COLUMNS)
    .eq("active", true);
  if (metric_id !== undefined) {
    if (!METRIC_CATALOG[metric_id]) return [];
    q = q.or(`metric_id.is.null,metric_id.eq.${metric_id}`);
  }
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) throw new Error(`data notes not read: ${error.message}`);
  return (data ?? []) as DataNote[];
}

export async function deactivateDataNote(tenant_id: string, id: string, by: string | null): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_data_notes")
    .update({ active: false, deactivated_at: new Date().toISOString(), deactivated_by: by })
    .eq("id", id)
    .eq("active", true)
    .select("id");
  if (error) throw new Error(`data note not removed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

export async function isTenantOwnerOrAdmin(tenant_id: string, user_id: string | null | undefined): Promise<boolean> {
  if (!user_id) return false;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_users")
    .select("role")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error || !data) return false;
  const role = (data as { role?: unknown }).role;
  return role === "owner" || role === "admin";
}

export function dataNoteCaveats(notes: DataNote[]): string[] {
  return notes.map(
    (n) =>
      `Founder data note, saved ${n.created_at.slice(0, 10)}: "${n.note_text}". ` +
      "This figure is the source's own number and does not apply the note, so say how the note changes it.",
  );
}
