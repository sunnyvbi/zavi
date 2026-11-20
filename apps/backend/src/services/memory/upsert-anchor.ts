
import { serviceClient } from "@/services/supabase";
import { embedTexts, VoyageDimError } from "./embed";
import { contextualizeChunks } from "./contextualize";
import type { MemoryDocSlug } from "./loader";
import type { BrainSlotSlug } from "./brain-slots";

const CHUNK_TARGET_CHARS = 2000;
const CHUNK_HARD_MAX = 4000;

function chunkText(text: string): string[] {
  if (!text) return [];
  const paragraphs = text.split(/\n{2,}/g).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.length > 0) {
      chunks.push(buf);
      buf = "";
    }
  };
  for (const p of paragraphs) {
    if (p.length > CHUNK_HARD_MAX) {
      flush();
      for (let i = 0; i < p.length; i += CHUNK_HARD_MAX) {
        chunks.push(p.slice(i, i + CHUNK_HARD_MAX));
      }
      continue;
    }
    if (buf.length + p.length + 2 > CHUNK_TARGET_CHARS) {
      flush();
    }
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return chunks;
}

export type DiscoveryDraftSlug = `${MemoryDocSlug}__inferred`;

export type UpsertAnchorInput = {
  tenant_id: string;
  slug: MemoryDocSlug | BrainSlotSlug | DiscoveryDraftSlug;
  title?: string;
  body_markdown: string;
  source?:
    | "human"
    | "praxis_staff"
    | "agent_write"
    | "agent_discovery_verified"
    | "agent_discovery_inferred"
    | "onboarding_seed";
  metadata?: Record<string, unknown>;
};

export type UpsertAnchorOpts = {
  skipEmbedding?: boolean;
  derivedFromCompanyRecord?: boolean;
};

export type UpsertAnchorResult = {
  note_id: string;
  chunks: number;
};

export const COMPANY_PROJECTION_ERROR =
  "The company brief is a projection of the company record, not a document. " +
  "Write the fact instead — services/company/facts.ts (free-form prose goes in " +
  "`company_story`) — then call regenerateCompanyBrief(). Writing this note " +
  "directly would be overwritten by the next render anyway.";

export async function upsertAnchor(
  input: UpsertAnchorInput,
  opts?: UpsertAnchorOpts,
): Promise<UpsertAnchorResult> {
  if (input.slug === "company" && !opts?.derivedFromCompanyRecord) {
    throw new Error(COMPANY_PROJECTION_ERROR);
  }

  const sb = serviceClient();

  const { data: noteIdRaw, error: rpcErr } = await sb.rpc("memory_note_upsert_anchor", {
    p_tenant_id: input.tenant_id,
    p_slug: input.slug,
    p_title: input.title ?? `${input.slug}.md`,
    p_body_markdown: input.body_markdown,
    p_source: input.source ?? "human",
    p_metadata: input.metadata ?? {},
  });
  if (rpcErr || !noteIdRaw) {
    throw new Error(
      `memory_note_upsert_anchor failed for ${input.slug}: ${rpcErr?.message ?? "no id returned"}`,
    );
  }
  return indexAnchorChunks(sb, input, noteIdRaw as string, opts);
}

export async function upsertAnchorGuarded(
  input: UpsertAnchorInput,
  allowedExistingSources: readonly string[],
  opts?: UpsertAnchorOpts,
): Promise<UpsertAnchorResult | null> {
  if (input.slug === "company" && !opts?.derivedFromCompanyRecord) {
    throw new Error(COMPANY_PROJECTION_ERROR);
  }
  const sb = serviceClient();
  const { data: noteIdRaw, error: rpcErr } = await sb.rpc("memory_note_upsert_anchor_guarded", {
    p_tenant_id: input.tenant_id,
    p_slug: input.slug,
    p_title: input.title ?? `${input.slug}.md`,
    p_body_markdown: input.body_markdown,
    p_source: input.source ?? "human",
    p_metadata: input.metadata ?? {},
    p_allowed_existing_sources: [...allowedExistingSources],
  });
  if (rpcErr) {
    throw new Error(`memory_note_upsert_anchor_guarded failed for ${input.slug}: ${rpcErr.message}`);
  }
  if (!noteIdRaw) return null;
  const note_id = noteIdRaw as string;
  const result = await indexAnchorChunks(sb, input, note_id, opts);

  if (result.chunks > 0) {
    const { data: after } = await sb
      .from("memory_note")
      .select("source")
      .eq("id", note_id)
      .maybeSingle();
    const nowSource = (after as { source?: string } | null)?.source;
    if (nowSource && nowSource !== (input.source ?? "human")) {
      await sb.from("memory_chunk").delete().eq("note_id", note_id);
      return { note_id, chunks: 0 };
    }
  }
  return result;
}

async function indexAnchorChunks(
  sb: ReturnType<typeof serviceClient>,
  input: UpsertAnchorInput,
  note_id: string,
  opts?: UpsertAnchorOpts,
): Promise<UpsertAnchorResult> {
  if (opts?.skipEmbedding) {
    return { note_id, chunks: 0 };
  }

  const chunks = chunkText(input.body_markdown);
  if (chunks.length === 0) {
    return { note_id, chunks: 0 };
  }

  const contextual = contextualizeChunks(chunks, {
    note_type: "anchor",
    title: input.title ?? `${input.slug}.md`,
  });

  let embeddings: number[][] = [];
  try {
    embeddings = await embedTexts(
      contextual.map((c) => c.contextualized),
      "document",
    );
  } catch (e) {
    if (e instanceof VoyageDimError) throw e;
    console.error(
      `[PRAXIS_EMBED_OUTAGE] upsertAnchor embed failed for ${input.slug} (tenant ${input.tenant_id}) — ` +
        `chunks will land with embedding=null; vector recall DEAD until backfilled. Cause:`,
      e,
    );
  }

  const rows = contextual.map((c, i) => ({
    tenant_id: input.tenant_id,
    note_id,
    chunk_index: i,
    body: c.body,
    context_text: c.contextualized,
    embedding: embeddings[i] ?? null,
  }));
  const { error: chunkErr } = await sb.from("memory_chunk").insert(rows);
  if (chunkErr) {
    throw new Error(`memory_chunk insert failed for anchor ${input.slug}: ${chunkErr.message}`);
  }
  return { note_id, chunks: rows.length };
}
