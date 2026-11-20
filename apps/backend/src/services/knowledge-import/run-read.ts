
import { deleteNote } from "@/services/memory";
import {
  beginReadCompensation,
  claimDocumentRead,
  downloadDocument,
  finishReadCompensation,
  getDocument,
  setDocumentExtraction,
} from "@/services/personalization/documents";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { readImportedFile } from "./read";
import { askNextConflict } from "./ask-conflict";
import { removeMachineFactsFromSource } from "@/services/company/facts";

export type ImportReadOutcome =
  | { kind: "stored"; stored: Record<string, unknown> }
  | { kind: "busy"; current: unknown }
  | { kind: "removed" }
  | { kind: "failed"; message: string };

async function importedExtraction(tenant_id: string, id: string): Promise<unknown> {
  try {
    const doc = await getDocument(tenant_id, id);
    return doc.status === "imported" ? doc.extraction : undefined;
  } catch {
    return undefined;
  }
}

export async function runImportRead(input: {
  tenant_id: string;
  user_id: string;
  doc: { id: string; filename: string; storage_path: string };
}): Promise<ImportReadOutcome> {
  const { tenant_id, user_id, doc } = input;
  const id = doc.id;
  const claimId = await claimDocumentRead(tenant_id, id);
  if (!claimId) {
    const stored = (await importedExtraction(tenant_id, id)) as { state?: string } | null | undefined;
    const current = !stored || stored.state === "compensating" ? { state: "reading" } : stored;
    await askNextConflict({ tenant_id, user_id }).catch(() => {});
    return { kind: "busy", current };
  }
  try {
    const buffer = await downloadDocument(tenant_id, doc.storage_path);
    const result = await readImportedFile({ tenant_id, doc_id: id, filename: doc.filename, buffer, claim_id: claimId });
    const { conflicts, ...stored } = "conflicts" in result ? result : { ...result, conflicts: [] };
    const stillMine = await setDocumentExtraction(tenant_id, id, claimId, { ...stored, claim_id: claimId, read_at: new Date().toISOString() });
    if (!stillMine) {
      await removeFactsOfClaim(tenant_id, user_id, id, claimId);
      return { kind: "removed" };
    }
    void conflicts;
    await askNextConflict({ tenant_id, user_id }).catch(() => {});
    return { kind: "stored", stored };
  } catch (e) {
    await compensateFailedRead(tenant_id, user_id, id, claimId).catch(() => {});
    return { kind: "failed", message: (e as Error).message };
  }
}

async function removeFactsOfClaim(tenant_id: string, user_id: string, id: string, claimId: string): Promise<void> {
  const refPattern = `tenant_document:${id}#%~${claimId}`;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("memory_note")
    .select("id")
    .eq("source", "document_import")
    .like("source_ref", refPattern)
    .limit(1000);
  if (error) throw new Error(error.message);
  for (const n of (data ?? []) as Array<{ id: string }>) {
    await deleteNote(tenant_id, n.id, user_id, "the read that wrote this lost its claim");
  }
  await removeMachineFactsFromSource(tenant_id, { prefix: `tenant_document:${id}#`, suffix: `~${claimId}` });
}

async function compensateFailedRead(tenant_id: string, user_id: string, id: string, claimId: string): Promise<void> {
  let ex: { state?: string; claim_id?: string } | null;
  try {
    const doc = await getDocument(tenant_id, id);
    ex = (doc.extraction ?? null) as typeof ex;
  } catch (e) {
    if ((e as { status?: number }).status !== 404) return;
    ex = { state: "deleting" };
  }
  if (ex?.state === "reading" && ex.claim_id === claimId) {
    if (!(await beginReadCompensation(tenant_id, id, claimId))) return;
    await removeFactsOfClaim(tenant_id, user_id, id, claimId);
    await finishReadCompensation(tenant_id, id, claimId);
    return;
  }
  const successor = !!ex?.claim_id && ex.claim_id !== claimId;
  if (ex === null || ex.state === "deleting" || successor) await removeFactsOfClaim(tenant_id, user_id, id, claimId);
}

export const IMPORT_READ_WAIT_MS = 10 * 60 * 1000;

export function importReadIsOpen(doc: { extraction: unknown; created_at: string }, now = Date.now()): boolean {
  const recent = (iso: string | undefined) => {
    const t = Date.parse(iso ?? "");
    return !Number.isFinite(t) || now - t <= IMPORT_READ_WAIT_MS;
  };
  const ex = doc.extraction as { state?: string; claimed_at?: string } | null | undefined;
  if (!ex) return recent(doc.created_at);
  if (ex.state === "reading" || ex.state === "compensating") return recent(ex.claimed_at ?? doc.created_at);
  return false;
}

export async function anyImportReadOpen(tenant_id: string, now = Date.now()): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_document")
    .select("extraction, created_at")
    .eq("status", "imported")
    .or("extraction.is.null,extraction->>state.in.(reading,compensating)")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ extraction: unknown; created_at: string }>).some((d) => importReadIsOpen(d, now));
}
