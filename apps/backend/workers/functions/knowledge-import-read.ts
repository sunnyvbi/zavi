
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getBoolSettingStrictResolved } from "@/services/settings";
import { claimDocumentRead, setDocumentExtraction } from "@/services/personalization/documents";
import { runImportRead, type ImportReadOutcome } from "@/services/knowledge-import/run-read";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ImportDocRow = {
  id: string;
  tenant_id: string;
  uploaded_by: string | null;
  status: string;
  filename: string;
  storage_path: string;
  extraction: unknown;
};

export type ImportReadDeps = {
  loadDoc: (doc_id: string) => Promise<ImportDocRow | null>;
  enabled: (tenant_id: string) => Promise<boolean>;
  run: typeof runImportRead;
};

export type ImportReadResult =
  | { skipped: "bad_id" | "not_found" | "not_imported" | "settled" | "no_uploader" | "setup_off" }
  | { outcome: ImportReadOutcome["kind"] };

function isSettled(extraction: unknown): boolean {
  const ex = extraction as { state?: string } | null | undefined;
  return !!ex && ex.state !== "reading" && ex.state !== "compensating";
}

export async function processImportRead(doc_id: string, deps: ImportReadDeps): Promise<ImportReadResult> {
  if (!ID_RE.test(doc_id ?? "")) return { skipped: "bad_id" };
  const row = await deps.loadDoc(doc_id);
  if (!row) return { skipped: "not_found" };
  if (row.status !== "imported") return { skipped: "not_imported" };
  if (isSettled(row.extraction)) return { skipped: "settled" };
  if (!row.uploaded_by) return { skipped: "no_uploader" };
  const tenant_id = row.tenant_id;
  if (!(await deps.enabled(tenant_id))) return { skipped: "setup_off" };
  const out = await deps.run({
    tenant_id,
    user_id: row.uploaded_by,
    doc: { id: row.id, filename: row.filename, storage_path: row.storage_path },
  });
  if (out.kind === "failed") throw new Error(`import read failed: ${out.message}`);
  return { outcome: out.kind };
}

async function loadDocByIdService(doc_id: string): Promise<ImportDocRow | null> {
  const { data, error } = await serviceClient()
    .from("tenant_document")
    .select("id, tenant_id, uploaded_by, status, filename, storage_path, extraction")
    .eq("id", doc_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ImportDocRow | null) ?? null;
}

export const EXHAUSTED_READ_REASON = "I couldn't read it right now, try again later";

export async function terminalizeExhaustedImportRead(
  doc_id: string,
  deps: {
    loadDoc: (doc_id: string) => Promise<ImportDocRow | null>;
    claim: typeof claimDocumentRead;
    store: typeof setDocumentExtraction;
  } = { loadDoc: loadDocByIdService, claim: claimDocumentRead, store: setDocumentExtraction },
): Promise<boolean> {
  if (!ID_RE.test(doc_id ?? "")) return false;
  const row = await deps.loadDoc(doc_id);
  if (!row || row.status !== "imported" || isSettled(row.extraction)) return false;
  const claimId = await deps.claim(row.tenant_id, row.id);
  if (!claimId) return false;
  return deps.store(row.tenant_id, row.id, claimId, {
    state: "unreadable",
    reason: EXHAUSTED_READ_REASON,
    claim_id: claimId,
    read_at: new Date().toISOString(),
  });
}

const BUSY_RECHECKS = 2;

export const knowledgeImportReadFn = inngest.createFunction(
  {
    id: "knowledge-import-read",
    retries: 2,
    onFailure: async ({ event }) => {
      const doc_id = String((event.data.event.data as { doc_id?: string })?.doc_id ?? "");
      await terminalizeExhaustedImportRead(doc_id);
    },
  },
  { event: "knowledge/import.read" },
  async ({ event, step }) => {
    const doc_id = String(event.data.doc_id ?? "");
    const deps = {
      loadDoc: loadDocByIdService,
      enabled: (tenant_id: string) => getBoolSettingStrictResolved("welcome_setup_enabled", tenant_id),
      run: runImportRead,
    };
    let out = await step.run("read", () => processImportRead(doc_id, deps));
    for (let i = 1; i <= BUSY_RECHECKS && "outcome" in out && out.outcome === "busy"; i += 1) {
      await step.sleep(`wait-for-claim-${i}`, "4m");
      out = await step.run(`read-again-${i}`, () => processImportRead(doc_id, deps));
    }
    if ("outcome" in out && out.outcome === "busy") throw new Error("import read busy: another reader still holds the claim");
    return out;
  },
);
