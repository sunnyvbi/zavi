
import { getCompanyFacts as realGetCompanyFacts } from "@/services/company/facts";
import { sanitizeDocumentText } from "./sanitize-doc";
import { extractText, extensionOf, fileKind } from "./extract-text";
import { scrubDocumentText } from "./scrub";
import { extractFacts as realExtractFacts } from "./extract-facts";
import { saveImportedFacts as realSave, type ConflictInfo } from "./save-facts";

export type ReadResult =
  | { state: "read"; facts: number; redactions: number; truncated: boolean; conflicts: ConflictInfo[] }
  | { state: "stored"; reason: "image" }
  | { state: "unreadable"; reason: string };

type Deps = {
  getCompanyFacts: typeof realGetCompanyFacts;
  extractFacts: typeof realExtractFacts;
  saveImportedFacts: typeof realSave;
};

export async function readImportedFile(
  input: { tenant_id: string; doc_id: string; filename: string; buffer: Buffer; claim_id: string },
  deps: Deps = { getCompanyFacts: realGetCompanyFacts, extractFacts: realExtractFacts, saveImportedFacts: realSave },
): Promise<ReadResult> {
  const kind = fileKind(input.filename);
  if (kind === "image") return { state: "stored", reason: "image" };
  const text = await extractText(input.buffer, extensionOf(input.filename));
  if (!text.ok) return { state: "unreadable", reason: text.reason };
  const ext = extensionOf(input.filename);
  const scrubKind = ext === "json" ? "json" : ext === "csv" ? "csv" : "text";
  const first = scrubDocumentText(text.text, scrubKind);
  const second = scrubDocumentText(sanitizeDocumentText(first.text), scrubKind);
  const clean = second.text;
  const redactions = first.count + second.count;
  if (!clean.trim()) return { state: "unreadable", reason: "no text in it" };
  const extracted = await deps.extractFacts({ tenant_id: input.tenant_id, filename: input.filename, text: clean });
  const existing = (await deps.getCompanyFacts(input.tenant_id)).facts;
  const saved = await deps.saveImportedFacts({
    tenant_id: input.tenant_id,
    doc_id: input.doc_id,
    claim_id: input.claim_id,
    filename: input.filename,
    facts: extracted.facts,
    existing,
  });
  return {
    state: "read",
    facts: saved.saved,
    redactions,
    truncated: extracted.truncated,
    conflicts: saved.conflicts,
  };
}
