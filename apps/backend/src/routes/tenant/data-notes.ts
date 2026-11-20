
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { deactivateDataNote, isTenantOwnerOrAdmin, listActiveDataNotes } from "@/services/analytics/data-notes";
import { METRIC_CATALOG } from "@/services/analytics/metric-registry";

const idSchema = z.string().uuid();

export async function listDataNotesHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const notes = await listActiveDataNotes(auth.tenant_id);
    res.json({
      notes: notes.map((n) => ({
        id: n.id,
        metric_id: n.metric_id,
        metric_label: n.metric_id ? (METRIC_CATALOG[n.metric_id]?.label ?? n.metric_id) : null,
        note_text: n.note_text,
        created_at: n.created_at,
      })),
    });
  } catch {
    res.status(500).json({ error: { code: "read_failed", message: "Could not read the data notes." } });
  }
}

export async function deleteDataNoteHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: { code: "validation", message: "Not a data note id." } });
    return;
  }
  if (!(await isTenantOwnerOrAdmin(auth.tenant_id, auth.user_id))) {
    res.status(403).json({ error: { code: "not_admin", message: "Only a workspace owner or admin can remove a data note." } });
    return;
  }
  try {
    const removed = await deactivateDataNote(auth.tenant_id, id.data, auth.user_id);
    if (!removed) {
      res.status(404).json({ error: { code: "not_found", message: "No such data note." } });
      return;
    }
    res.json({ removed: true });
  } catch {
    res.status(500).json({ error: { code: "write_failed", message: "Could not remove the data note." } });
  }
}
