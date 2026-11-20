
import { writeNote as realWriteNote } from "@/services/memory";
import { projectCompanyFactValue, type CompanyFact } from "@/services/company/facts";
import type { ExtractedFact, FileFactKey } from "./extract-facts";

export type ConflictInfo = {
  note_id: string;
  key: FileFactKey;
  file_value: string;
  existing_value: string;
  existing_source: string;
  filename: string;
  line: number;
};

export function sourceRefFor(doc_id: string, line: number, claim_id: string): string {
  return `tenant_document:${doc_id}#L${line}~${claim_id}`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function classifyKeyed(
  key: FileFactKey,
  fileValue: string,
  existing: CompanyFact | undefined,
): "project" | "same" | "conflict" {
  if (!existing || !existing.value.trim()) return "project";
  if (key === "competitors") return "same";
  if (norm(existing.value) === norm(fileValue)) return "same";
  if (existing.source === "ai_estimated") return "project";
  if (existing.source === "onboarding_enrichment" && !(existing.source_ref ?? "").startsWith("tenant_document:")) return "project";
  return "conflict";
}

type Deps = {
  writeNote: typeof realWriteNote;
  project: typeof projectCompanyFactValue;
};

export async function saveImportedFacts(
  input: {
    tenant_id: string;
    doc_id: string;
    claim_id: string;
    filename: string;
    facts: ExtractedFact[];
    existing: Partial<Record<string, CompanyFact>>;
  },
  deps: Deps = { writeNote: realWriteNote, project: projectCompanyFactValue },
): Promise<{ saved: number; conflicts: ConflictInfo[] }> {
  const conflicts: ConflictInfo[] = [];
  const projected = new Set<string>();
  let saved = 0;
  for (const fact of input.facts) {
    const source_ref = sourceRefFor(input.doc_id, fact.line, input.claim_id);
    let conflict: Record<string, unknown> | null = null;
    if (fact.key && fact.value) {
      const existing = input.existing[fact.key];
      const verdict = classifyKeyed(fact.key, fact.value, existing);
      if (verdict === "project" && !projected.has(fact.key)) {
        projected.add(fact.key);
        const out = await deps.project(input.tenant_id, fact.key, fact.value, "onboarding_enrichment", source_ref);
        if (out?.error) throw new Error(`company fact projection failed: ${out.error}`);
      } else if (verdict === "conflict" && existing) {
        conflict = {
          key: fact.key,
          file_value: fact.value,
          existing_value: existing.value,
          existing_source: existing.source,
          status: "open",
          asked_at: null,
        };
      }
    }
    const { note_id } = await deps.writeNote(input.tenant_id, {
      title: fact.text.slice(0, 200),
      body_markdown: `${fact.text}\n\n> ${fact.quote}\n\nFrom ${input.filename}, line ${fact.line}.`,
      dedup_key: `import:${input.doc_id}:${input.claim_id}`,
      source: "document_import",
      source_ref,
      note_type: "tenant_reference",
      tags: ["from-file"],
      metadata: {
        document_id: input.doc_id,
        claim_id: input.claim_id,
        filename: input.filename,
        line: fact.line,
        quote: fact.quote,
        ...(fact.key ? { key: fact.key } : {}),
        ...(conflict ? { conflict } : {}),
      },
    });
    saved += 1;
    if (conflict && fact.key && fact.value) {
      conflicts.push({
        note_id,
        key: fact.key,
        file_value: fact.value,
        existing_value: String(conflict.existing_value),
        existing_source: String(conflict.existing_source),
        filename: input.filename,
        line: fact.line,
      });
    }
  }
  return { saved, conflicts };
}
