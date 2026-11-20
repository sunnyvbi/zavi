
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { getBoolSetting } from "@/services/settings";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { deleteNote, PRIVATE_NOTE_TYPES_PGREST_IN } from "@/services/memory";
import {
  claimDocumentDeletion,
  deleteImportedRow,
  getDocument,
  listImportedDocuments,
  removeImportedObject,
} from "@/services/personalization/documents";
import { runImportRead } from "@/services/knowledge-import/run-read";
import { askNextConflict } from "@/services/knowledge-import/ask-conflict";
import { removeMachineFactsFromSource } from "@/services/company/facts";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTING = "welcome_setup_enabled";

function idOf(req: Request, res: Response): string | null {
  const id = req.params.id;
  if (!ID_RE.test(id ?? "")) {
    res.status(400).json({ error: { code: "bad_id", message: "invalid document id" } });
    return null;
  }
  return id;
}

async function importedDoc(tenant_id: string, id: string) {
  try {
    const doc = await getDocument(tenant_id, id);
    return doc.status === "imported" ? doc : null;
  } catch {
    return null;
  }
}

export async function readImport(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const id = idOf(req, res);
  if (!id) return;
  if (!(await getBoolSetting(SETTING, auth.tenant_id))) {
    res.status(409).json({ error: { code: "setup_off", message: "Reading files is turned off." } });
    return;
  }
  const doc = await importedDoc(auth.tenant_id, id);
  if (!doc) {
    res.status(404).json({ error: { code: "not_found", message: "file not found" } });
    return;
  }
  const out = await runImportRead({ tenant_id: auth.tenant_id, user_id: auth.user_id, doc });
  if (out.kind === "busy") {
    res.json(out.current);
  } else if (out.kind === "stored") {
    res.json(out.stored);
  } else if (out.kind === "removed") {
    res.status(409).json({ error: { code: "file_removed", message: "This file was removed while I was reading it." } });
  } else {
    res.status(500).json({ error: { code: "read_failed", message: out.message } });
  }
}

type NoteRow = { id: string; title: string; source_ref: string | null; metadata: Record<string, unknown> | null };

export async function listImports(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const cursor = typeof req.query?.cursor === "string" ? req.query.cursor : null;
  try {
    const page = await listImportedDocuments(auth.tenant_id, { cursor, limit: 50 });
    const ids = page.documents.map((d) => d.id);
    const byDoc = new Map<string, Array<{ id: string; text: string; quote: string; line: number | null }>>();
    if (ids.length > 0) {
      const { data, error } = await tenantClient(asTenantId(auth.tenant_id))
        .from("memory_note")
        .select("id, title, source_ref, metadata")
        .eq("source", "document_import")
        .not("note_type", "in", PRIVATE_NOTE_TYPES_PGREST_IN)
        .is("superseded_by", null)
        .in("metadata->>document_id", ids)
        .order("created_at", { ascending: true })
        .limit(ids.length * 40);
      if (error) throw new Error(error.message);
      for (const n of (data ?? []) as NoteRow[]) {
        const docId = typeof n.metadata?.document_id === "string" ? n.metadata.document_id : null;
        if (!docId) continue;
        const list = byDoc.get(docId) ?? [];
        list.push({
          id: n.id,
          text: n.title,
          quote: typeof n.metadata?.quote === "string" ? n.metadata.quote : "",
          line: typeof n.metadata?.line === "number" ? n.metadata.line : null,
        });
        byDoc.set(docId, list);
      }
    }
    res.json({
      files: page.documents.map((d) => ({ ...d, facts: byDoc.get(d.id) ?? [] })),
      next_cursor: page.next_cursor,
    });
  } catch (e) {
    res.status(500).json({ error: { code: "list_failed", message: (e as Error).message } });
  }
}

export async function deleteImport(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const id = idOf(req, res);
  if (!id) return;
  const doc = await importedDoc(auth.tenant_id, id);
  if (!doc) {
    res.status(404).json({ error: { code: "not_found", message: "file not found" } });
    return;
  }
  try {
    if (!(await claimDocumentDeletion(auth.tenant_id, id))) {
      res.status(409).json({ error: { code: "file_busy", message: "I'm still reading this file. Try again in a moment." } });
      return;
    }
    await removeImportedObject(auth.tenant_id, id);
    await removeFactsOfDocument(auth.tenant_id, auth.user_id, id);
    await deleteImportedRow(auth.tenant_id, id);
    await askNextConflict({ tenant_id: auth.tenant_id, user_id: auth.user_id }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: { code: "delete_failed", message: (e as Error).message } });
  }
}

const NOTE_ID_RE = ID_RE;

async function removeFactsOfDocument(tenant_id: string, user_id: string, id: string): Promise<void> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("memory_note")
    .select("id")
    .eq("source", "document_import")
    .like("source_ref", `tenant_document:${id}#%`)
    .limit(1000);
  if (error) throw new Error(error.message);
  for (const n of (data ?? []) as Array<{ id: string }>) {
    await deleteNote(tenant_id, n.id, user_id, "the imported file was removed");
  }
  await removeMachineFactsFromSource(tenant_id, { prefix: `tenant_document:${id}#` });
}

export async function deleteImportedFact(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const id = req.params.id;
  if (!NOTE_ID_RE.test(id ?? "")) {
    res.status(400).json({ error: { code: "bad_id", message: "invalid fact id" } });
    return;
  }
  try {
    const { data, error } = await tenantClient(asTenantId(auth.tenant_id))
      .from("memory_note")
      .select("id, source_ref, metadata")
      .eq("id", id)
      .eq("source", "document_import")
      .maybeSingle();
    if (error) throw new Error(error.message);
    const note = data as { id: string; source_ref: string | null; metadata: Record<string, unknown> | null } | null;
    if (!note) {
      res.status(404).json({ error: { code: "not_found", message: "fact not found" } });
      return;
    }
    const key = typeof note.metadata?.key === "string" ? note.metadata.key : null;
    if (key && note.source_ref) await removeMachineFactsFromSource(auth.tenant_id, { exact: note.source_ref, key });
    await deleteNote(auth.tenant_id, id, auth.user_id, "founder removed an imported fact");
    await askNextConflict({ tenant_id: auth.tenant_id, user_id: auth.user_id }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: { code: "delete_failed", message: (e as Error).message } });
  }
}
