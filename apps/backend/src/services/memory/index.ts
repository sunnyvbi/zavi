
import { serviceClient } from "@/services/supabase";
import { embedTexts, embedOne, EMBED_DIM, VoyageDimError } from "./embed";
import { contextualizeChunks } from "./contextualize";
import { l2Norm, recordSearchTrace } from "./trace";
import { runLexicalFallback, toSearchHits } from "./degraded-ladder";
import { extractEntities, extractEntitiesAndRelations, type TypedGraphResult } from "./extract";
import { isLlmEntityExtractEnabledForTenant } from "./llm-entity-extract-flag";
import { upsertAnchor } from "./upsert-anchor";
import { classifyEntityGrounding } from "./entity-causal-grounding-verifier";
import type { ToolCallTrace } from "@/services/tools/types";
import { MEMORY_SLUGS, type MemoryDocSlug } from "./loader";
import {
  recordEvalCapture,
  _trackForDrain,
  type RecordEvalCaptureInput,
} from "./eval-capture";
import {
  assertBoundedFrontmatter,
  extractFrontmatterLinks,
} from "./link-extraction";
import { applyTrustTierPrecedence, applyRelevanceFloor } from "./precedence";
import { isRerankerEnabledForTenant } from "./reranker-flag";
import {
  rerankDocuments,
  RERANK_POOL_K,
  RERANK_MAX_DOC_CHARS,
  RERANK_MODEL_NAME,
  RERANK_TIMEOUT_MS,
  RERANK_STAGE_MS,
} from "./rerank";
import type { RerankStatus } from "./trace";
import { contentHash } from "./content-hash";
import { maybeResolveConflict, type ConflictDecision } from "./conflict-resolution";
import { logReview } from "@/services/logging/log-review";
import {
  maybeExtractValidTime,
  closeValidInterval,
  factHoldsAtValidTime,
} from "./valid-time";
import { normalizeConnectorKeys, toPrefilterArg } from "./connector-keys";
import { getNumberSetting, getStringSetting } from "@/services/settings";
import { writeMutationAudit, buildDeleteSnapshot } from "./mutation-audit";

function fireAndForgetCapture(input: RecordEvalCaptureInput): void {
  const p = recordEvalCapture(input).catch((err) => {
    console.warn(`[eval-capture] swallowed error: ${(err as Error)?.message ?? err}`);
  });
  _trackForDrain(p);
}

export class NoteNotFoundError extends Error {
  constructor(tenant_id: string, note_id: string) {
    super(`memory_note ${note_id} not found in tenant ${tenant_id}`);
    this.name = "NoteNotFoundError";
  }
}

export type WriteNoteSource =
  | "human"
  | "agent_run"
  | "slack_distill"
  | "email_distill"
  | "operator_feedback"
  | "praxis_staff"
  | "auto_distill_chat"
  | "auto_distill_agent_run"
  | "auto_distill_slack"
  | "dream_cycle_merge"
  | "agent_write"
  | "gap_distill"
  | "episode_distill"
  | "external_learning_distill"
  | "meeting_distill"
  | "memory_card_distill"
  | "document_import"
  | "onboarding_seed";

export type WriteNoteType =
  | "operator_preference"
  | "agent_feedback"
  | "tenant_project"
  | "tenant_reference"
  | "untyped"
  | "pattern"
  | "growth_cross_bet"
  | "growth_priorities"
  | "growth_strategy"
  | "growth_attribution_snapshot"
  | "ads_channel_perf"
  | "social_approved_drafts"
  | "growth_funnel_diagnosis"
  | "growth_lever_signal"
  | "knowledge_gap"
  | "correction"
  | "agent_experience"
  | "learning"
  | "skill"
  | "agent_procedural";

export const PRIVATE_NOTE_TYPES = ["agent_experience", "agent_procedural"] as const;
export const PRIVATE_NOTE_TYPE_SET: ReadonlySet<string> = new Set(PRIVATE_NOTE_TYPES);
export const PRIVATE_NOTE_TYPES_PGREST_IN = `(${PRIVATE_NOTE_TYPES.join(",")})`;

export type WriteNoteInput = {
  id?: string | null;
  title?: string;
  body_markdown: string;
  source?: WriteNoteSource;
  source_ref?: string | null;
  tags?: string[];
  note_type?: WriteNoteType;
  agent_slug?: string | null;
  trust_tier?: number | null;
  toolCalls?: ToolCallTrace[];
  slug?: MemoryDocSlug | null;
  frontmatter?: Record<string, string | string[]>;
  metadata?: Record<string, unknown>;
  thread_id?: string | null;
  connector_object_keys?: string[] | null;
  dedup_key?: string | null;
  subject?: string | null;
  attribute?: string | null;
  value_kind?: "id" | "money" | "rate" | "other" | null;
  source_class?: "user_stated" | "agent_inferred" | "fetched_web" | "connector" | null;
};

export type WriteNoteResult = {
  note_id: string;
  chunks: number;
  entities: number;
  edges?: number;
  created?: boolean;
  enrichment?: "pending";
};

const LEX_RESCUE_RESERVE_MS = 700;

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

async function applyConflictSupersedes(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  winnerId: string,
  targetIds: string[] | undefined,
  cosine: number | undefined,
  label: string,
  closeValidFrom?: string | null,
): Promise<void> {
  for (const targetId of targetIds ?? []) {
    if (targetId === winnerId) continue;
    const { error: rpcErr } = await sb.rpc("apply_dream_verdict", {
      p_tenant_id: tenant_id,
      p_new_id: winnerId,
      p_existing_id: targetId,
      p_verdict: "KEEP_NEW",
      p_rationale: `conflict-resolution: ${label} (cosine=${cosine ?? "n/a"})`,
    });
    if (rpcErr) {
      console.warn(
        `[memory] conflict-resolution: apply_dream_verdict (${label}) failed for ${targetId}:`,
        rpcErr.message,
      );
      continue;
    }
    if (closeValidFrom) {
      await closeValidInterval(sb, tenant_id, targetId, closeValidFrom);
    }
  }
}

function logConflictReview(
  tenant_id: string,
  conflict: ConflictDecision,
  noteId: string,
  ms?: number,
): void {
  try {
    const outcome = conflict.classifyFailed ? "classify_failed" : conflict.relation;
    if (
      outcome !== "supersede" &&
      outcome !== "noop" &&
      outcome !== "extend" &&
      outcome !== "classify_failed"
    ) {
      return;
    }
    const meta: Record<string, number> = {
      supersede_count: conflict.supersedeTargetIds?.length ?? 0,
      blocked_by_trust: conflict.supersedeBlockedByTrust ? 1 : 0,
      blocked_by_date: conflict.supersedeBlockedByDate ? 1 : 0,
    };
    if (typeof ms === "number" && Number.isFinite(ms)) meta.ms = Math.round(ms);
    if (typeof conflict.cosine === "number" && Number.isFinite(conflict.cosine)) {
      meta.cosine = Math.round(conflict.cosine * 1000) / 1000;
    }
    logReview({
      feature: "memory_conflict",
      event: "resolve",
      outcome,
      run_id: noteId,
      tenant_id,
      meta,
    });
  } catch {
  }
}

async function writeNoteChunks(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  note_id: string,
  note: { title: string; note_type: string; body_markdown: string },
): Promise<{ chunks: number; complete: boolean }> {
  const chunks = chunkText(note.body_markdown);
  if (chunks.length === 0) return { chunks: 0, complete: true };
  const contextual = contextualizeChunks(chunks, {
    note_type: note.note_type,
    title: note.title,
  });
  let embeddings: number[][] = [];
  let embedded = true;
  try {
    embeddings = await embedTexts(
      contextual.map((c) => c.contextualized),
      "document",
    );
  } catch (e) {
    if (e instanceof VoyageDimError) throw e;
    embedded = false;
    console.error(
      `[PRAXIS_EMBED_OUTAGE] embed failed for note ${note_id} — chunks will land with embedding=null; ` +
        `vector recall for this note will be DEAD until the retry worker finishes it. Cause:`,
      e,
    );
  }
  const rows = contextual.map((c, i) => ({
    tenant_id,
    note_id,
    chunk_index: i,
    body: c.body,
    context_text: c.contextualized,
    embedding: embeddings[i] ?? null,
  }));
  const { error: chunkErr } = await sb.from("memory_chunk").insert(rows);
  if (chunkErr) {
    console.error(
      `[memory] chunk insert failed for note ${note_id}; left pending for the retry worker: ${chunkErr.message}`,
    );
    return { chunks: 0, complete: false };
  }
  return { chunks: rows.length, complete: embedded && embeddings.length === rows.length };
}

async function markEnrichment(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  note_id: string,
  complete: boolean,
): Promise<void> {
  if (!complete) return;
  const { error } = await sb
    .from("memory_note")
    .update({ enrichment_state: "done", enrichment_attempts: 0 })
    .eq("id", note_id)
    .eq("tenant_id", tenant_id);
  if (error) console.warn(`[memory] enrichment state flip failed for ${note_id}: ${error.message}`);
}

export const MAX_ENRICHMENT_ATTEMPTS = 5;

export async function finishPendingNote(
  tenant_id: string,
  note_id: string,
): Promise<"done" | "pending" | "failed" | "skipped"> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("memory_note")
    .select("id, title, note_type, body_markdown, enrichment_state, enrichment_attempts")
    .eq("id", note_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(`finishPendingNote read failed: ${error.message}`);
  const row = data as {
    id: string;
    title: string | null;
    note_type: string | null;
    body_markdown: string | null;
    enrichment_state: string;
    enrichment_attempts: number | null;
  } | null;
  if (!row || row.enrichment_state !== "pending") return "skipped";
  const attempts = (row.enrichment_attempts ?? 0) + 1;
  await sb.from("memory_chunk").delete().eq("note_id", note_id).eq("tenant_id", tenant_id);
  const r = await writeNoteChunks(sb, tenant_id, note_id, {
    title: row.title ?? "",
    note_type: row.note_type ?? "untyped",
    body_markdown: row.body_markdown ?? "",
  });
  if (r.complete) {
    await markEnrichment(sb, tenant_id, note_id, true);
    return "done";
  }
  const state = attempts >= MAX_ENRICHMENT_ATTEMPTS ? "failed" : "pending";
  await sb
    .from("memory_note")
    .update({ enrichment_state: state, enrichment_attempts: attempts })
    .eq("id", note_id)
    .eq("tenant_id", tenant_id);
  return state;
}

export async function writeNote(
  tenant_id: string,
  input: WriteNoteInput,
): Promise<WriteNoteResult> {
  if (input.slug) {
    if (!(MEMORY_SLUGS as readonly string[]).includes(input.slug)) {
      throw new Error(`writeNote: invalid anchor slug ${JSON.stringify(input.slug)}`);
    }
    const result = await upsertAnchor({
      tenant_id,
      slug: input.slug,
      title: input.title,
      body_markdown: input.body_markdown,
      source: input.source === "agent_write" ? "agent_write" : "human",
    });
    return { note_id: result.note_id, chunks: result.chunks, entities: 0 };
  }

  const sb = serviceClient();
  const noteRow: Record<string, unknown> = {
    tenant_id,
    title: input.title ?? "",
    body_markdown: input.body_markdown ?? "",
    source: input.source ?? "human",
    source_ref: input.source_ref ?? null,
    tags: input.tags ?? [],
    note_type: input.note_type ?? "untyped",
    updated_at: new Date().toISOString(),
  };
  if (input.agent_slug !== undefined) noteRow.agent_slug = input.agent_slug;
  if (input.trust_tier !== undefined && input.trust_tier !== null) {
    noteRow.trust_tier = input.trust_tier;
  }
  if (input.thread_id !== undefined && input.thread_id !== null) {
    noteRow.thread_id = input.thread_id;
  }
  const writeConnectorKeys = normalizeConnectorKeys(input.connector_object_keys ?? []);
  if (writeConnectorKeys.length > 0) {
    noteRow.connector_object_keys = writeConnectorKeys;
  }
  const noteContentHash = contentHash(
    tenant_id,
    input.note_type ?? "untyped",
    input.body_markdown ?? "",
    input.agent_slug ?? null,
    input.dedup_key ?? null,
  );
  noteRow.content_hash = noteContentHash;
  if (input.metadata !== undefined) noteRow.metadata = input.metadata;
  if (input.subject) noteRow.subject = input.subject;
  if (input.attribute) noteRow.attribute = input.attribute;
  if (input.value_kind) noteRow.value_kind = input.value_kind;
  if (input.source_class) noteRow.source_class = input.source_class;
  noteRow.enrichment_state = "pending";

  if (input.toolCalls !== undefined && typeof noteRow.body_markdown === "string" && noteRow.body_markdown) {
    const verdict = classifyEntityGrounding({
      body: noteRow.body_markdown,
      toolCalls: input.toolCalls,
    });
    if (verdict.hasEntityClaim) {
      const meta = (noteRow.metadata as Record<string, unknown> | undefined) ?? {};
      if (verdict.grounded && verdict.groundedBy) {
        noteRow.metadata = {
          ...meta,
          grounded_by: { ...verdict.groundedBy, at: new Date().toISOString() },
        };
      } else {
        noteRow.trust_tier = 3;
        noteRow.metadata = {
          ...meta,
          claim_status: "unverified",
          entity_gate_reason: verdict.reason,
        };
        console.warn(
          `[memory] entity-grounding gate: demoted note to trust_tier=3 (${verdict.reason}); ` +
            `atoms=${verdict.atoms.map((a) => `${a.kind}:${a.ref}`).join(",")} ` +
            `source=${input.source ?? "human"} ref=${input.source_ref ?? "null"}`,
        );
      }
    }
  }

  let note_id: string;
  let bodyInsertedOrChanged = false;
  let createdNew = false;
  if (input.id) {
    const { data, error } = await sb
      .from("memory_note")
      .update(noteRow)
      .eq("id", input.id)
      .eq("tenant_id", tenant_id)
      .select("id")
      .maybeSingle();
    if (error) {
      throw new Error(`memory_note update failed: ${error.message}`);
    }
    if (!data) {
      throw new NoteNotFoundError(tenant_id, input.id);
    }
    note_id = data.id as string;
    bodyInsertedOrChanged = true;
    await sb.from("memory_chunk").delete().eq("note_id", note_id).eq("tenant_id", tenant_id);
  } else {
    type DupRow = {
      id: string;
      body_markdown: string | null;
      tags: string[] | null;
      metadata: Record<string, unknown> | null;
      connector_object_keys: string[] | null;
    };
    const findLiveDup = async (): Promise<DupRow | null> => {
      const { data } = await sb
        .from("memory_note")
        .select("id, body_markdown, tags, metadata, connector_object_keys")
        .eq("tenant_id", tenant_id)
        .eq("content_hash", noteContentHash)
        .is("slug", null)
        .is("superseded_by", null)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data as DupRow) ?? null;
    };

    let dup = await findLiveDup();
    let resolvedId: string | null = null;
    let validTime: Awaited<ReturnType<typeof maybeExtractValidTime>> = null;
    if (!dup) {
      validTime = await maybeExtractValidTime(
        tenant_id,
        input.title ?? "",
        input.body_markdown ?? "",
      );
      if (validTime?.valid_from) noteRow.valid_from = validTime.valid_from;
      if (validTime?.valid_to) noteRow.valid_to = validTime.valid_to;
      const conflictStartedAt = Date.now();
      const conflict = await maybeResolveConflict(tenant_id, {
        title: input.title ?? "",
        body: input.body_markdown ?? "",
        note_type: input.note_type ?? "untyped",
        trust_tier: input.trust_tier ?? undefined,
      });
      const conflictMs = conflict ? Date.now() - conflictStartedAt : undefined;
      if (conflict?.relation === "noop" && conflict.targetNoteId) {
        const winnerId = conflict.targetNoteId;
        const { data: winnerRow } = await sb
          .from("memory_note")
          .select("tags, metadata, connector_object_keys, trust_tier, source_ref, thread_id, agent_slug")
          .eq("id", winnerId)
          .eq("tenant_id", tenant_id)
          .is("superseded_by", null)
          .maybeSingle();
        if (winnerRow) {
          const w = winnerRow as {
            tags: string[] | null;
            metadata: Record<string, unknown> | null;
            connector_object_keys: string[] | null;
            trust_tier: number | null;
            source_ref: string | null;
            thread_id: string | null;
            agent_slug: string | null;
          };
          const upd: Record<string, unknown> = {
            tags: Array.from(new Set([...(w.tags ?? []), ...(input.tags ?? [])])),
            updated_at: new Date().toISOString(),
          };
          if (input.metadata !== undefined) {
            upd.metadata = { ...(w.metadata ?? {}), ...input.metadata };
          }
          if (writeConnectorKeys.length > 0) {
            const mergedKeys = normalizeConnectorKeys([
              ...(w.connector_object_keys ?? []),
              ...writeConnectorKeys,
            ]);
            if (mergedKeys.length > (w.connector_object_keys?.length ?? 0)) {
              upd.connector_object_keys = mergedKeys;
            }
          }
          const incomingTier = input.trust_tier ?? 2;
          const winnerTier = w.trust_tier ?? 2;
          const mergedTier = Math.min(winnerTier, incomingTier);
          if (mergedTier !== winnerTier) upd.trust_tier = mergedTier;
          if (!w.source_ref && input.source_ref) upd.source_ref = input.source_ref;
          if (!w.thread_id && input.thread_id) upd.thread_id = input.thread_id;
          if (!w.agent_slug && input.agent_slug) upd.agent_slug = input.agent_slug;

          const { data: mergedRows, error: mergeErr } = await sb
            .from("memory_note")
            .update(upd)
            .eq("id", winnerId)
            .eq("tenant_id", tenant_id)
            .is("superseded_by", null)
            .select("id");
          if (!mergeErr && mergedRows && mergedRows.length > 0) {
            await applyConflictSupersedes(
              sb,
              tenant_id,
              winnerId,
              conflict.supersedeTargetIds,
              conflict.cosine,
              "noop+supersede",
            );
            logConflictReview(tenant_id, conflict, winnerId, conflictMs);
            return { note_id: winnerId, chunks: 0, entities: 0 };
          }
          console.warn(
            `[memory] conflict-resolution: noop winner ${winnerId} not live / merge failed; inserting new note instead.`,
            mergeErr?.message ?? "0 rows",
          );
        }
      }
      if (conflict?.supersedeBlockedByTrust || conflict?.supersedeBlockedByDate) {
        noteRow.metadata = {
          ...((noteRow.metadata as Record<string, unknown>) ?? {}),
          ...(conflict.supersedeBlockedByTrust ? { supersede_blocked_by_trust: true } : {}),
          ...(conflict.supersedeBlockedByDate ? { supersede_blocked_by_date: true } : {}),
        };
      }

      const { data, error } = await sb
        .from("memory_note")
        .insert(noteRow)
        .select("id")
        .single();
      if (error) {
        if ((error as { code?: string }).code === "23505") {
          dup = await findLiveDup();
        }
        if (!dup) throw new Error(`memory_note insert failed: ${error.message}`);
      } else if (!data) {
        throw new Error("memory_note insert failed: no row returned");
      } else {
        resolvedId = data.id as string;
        bodyInsertedOrChanged = true;
        createdNew = true;
        if (conflict?.supersedeTargetIds?.length) {
          await applyConflictSupersedes(
            sb,
            tenant_id,
            resolvedId,
            conflict.supersedeTargetIds,
            conflict.cosine,
            "supersede",
            validTime?.valid_from,
          );
        }
        if (conflict) logConflictReview(tenant_id, conflict, resolvedId, conflictMs);
      }
    }

    if (dup) {
      const d = dup;
      resolvedId = d.id;
      const mergedTags = Array.from(new Set([...(d.tags ?? []), ...(input.tags ?? [])]));
      const bodyChanged = (d.body_markdown ?? "") !== (input.body_markdown ?? "");
      bodyInsertedOrChanged = bodyChanged;
      const upd: Record<string, unknown> = {
        body_markdown: input.body_markdown ?? d.body_markdown ?? "",
        tags: mergedTags,
        updated_at: new Date().toISOString(),
      };
      if (input.title) upd.title = input.title;
      if (bodyChanged) upd.enrichment_state = "pending";
      if (input.metadata !== undefined) upd.metadata = { ...(d.metadata ?? {}), ...input.metadata };
      if (writeConnectorKeys.length > 0) {
        const mergedKeys = normalizeConnectorKeys([
          ...(d.connector_object_keys ?? []),
          ...writeConnectorKeys,
        ]);
        if (mergedKeys.length > (d.connector_object_keys?.length ?? 0)) {
          upd.connector_object_keys = mergedKeys;
        }
      }
      const { error: mergeErr } = await sb
        .from("memory_note")
        .update(upd)
        .eq("id", d.id)
        .eq("tenant_id", tenant_id);
      if (mergeErr) {
        throw new Error(`memory_note dedup-merge failed: ${mergeErr.message}`);
      }
      if (!bodyChanged) {
        return { note_id: d.id, chunks: 0, entities: 0, edges: 0 };
      }
      await sb.from("memory_chunk").delete().eq("note_id", d.id).eq("tenant_id", tenant_id);
    }

    if (!resolvedId) throw new Error("writeNote: note_id unresolved (unreachable)");
    note_id = resolvedId;
  }

  const chunkResult = await writeNoteChunks(sb, tenant_id, note_id, {
    title: input.title ?? "",
    note_type: input.note_type ?? "untyped",
    body_markdown: input.body_markdown,
  });
  const chunkCount = chunkResult.chunks;
  await markEnrichment(sb, tenant_id, note_id, chunkResult.complete);

  const { entities } = extractEntities(input.body_markdown);
  let entityCount = 0;
  for (const e of entities) {
    const { error: directErr } = await sb
      .from("memory_entity")
      .upsert(
        {
          tenant_id,
          entity_type: e.entity_type,
          canonical_name: e.canonical_name,
          attrs: e.attrs ?? {},
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,entity_type,canonical_name" },
      );
    if (directErr) {
      console.warn(`[memory] entity upsert failed for ${e.canonical_name}:`, directErr.message);
      continue;
    }
    entityCount += 1;

    const { data: entRow } = await sb
      .from("memory_entity")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("entity_type", e.entity_type)
      .eq("canonical_name", e.canonical_name)
      .maybeSingle();
    if (entRow && (entRow as { id: string }).id) {
      const { error: mentionErr } = await sb
        .from("memory_note_entity")
        .upsert(
          {
            tenant_id,
            note_id,
            entity_id: (entRow as { id: string }).id,
          },
          { onConflict: "tenant_id,note_id,entity_id", ignoreDuplicates: true },
        );
      if (mentionErr) {
        console.warn(
          `[memory] note_entity mention insert failed for ${e.canonical_name}:`,
          mentionErr.message,
        );
      }
    }
  }

  let edgeCount = 0;
  if (input.frontmatter !== undefined) {
    try {
      edgeCount = await persistFrontmatterEdges(
        sb,
        tenant_id,
        note_id,
        input.frontmatter,
      );
    } catch (e) {
      console.warn(
        `[memory] frontmatter edge extraction failed for note ${note_id}:`,
        (e as Error)?.message ?? e,
      );
    }
  }

  try {
    if (bodyInsertedOrChanged && (await isLlmEntityExtractEnabledForTenant(tenant_id))) {
      let extractFailure: { http_status?: number; error_class?: string } | null = null;
      const extractStartedAt = Date.now();
      const graph = await extractEntitiesAndRelations(
        `${input.title ?? ""}\n\n${input.body_markdown ?? ""}`,
        tenant_id,
        { onError: (info) => { extractFailure = info; } },
      );
      const extractMs = Date.now() - extractStartedAt;
      if (graph.entities.length > 0 || graph.relations.length > 0) {
        const persisted = await persistTypedGraph(tenant_id, note_id, graph);
        entityCount += persisted.entities;
        edgeCount += persisted.relations;
      }
      try {
        if (extractFailure) {
          const f = extractFailure as { http_status?: number; error_class?: string };
          logReview({
            feature: "memory_extract",
            event: "write",
            outcome: "failed",
            run_id: note_id,
            tenant_id,
            meta: { http_status: f.http_status, error_class: f.error_class, ms: extractMs },
          });
        } else if (graph.entities.length > 0) {
          logReview({
            feature: "memory_extract",
            event: "write",
            outcome: "ok",
            run_id: note_id,
            tenant_id,
            meta: { entities: graph.entities.length, edges: graph.relations.length, ms: extractMs },
          });
        }
      } catch {
      }
    }
  } catch (e) {
    console.warn(
      `[memory] llm entity extraction failed for note ${note_id}:`,
      (e as Error)?.message ?? e,
    );
  }

  return {
    note_id,
    chunks: chunkCount,
    entities: entityCount,
    edges: edgeCount,
    ...(createdNew ? { created: true } : {}),
    ...(chunkResult.complete ? {} : { enrichment: "pending" as const }),
  };
}

async function persistFrontmatterEdges(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  note_id: string,
  frontmatter: Record<string, unknown>,
): Promise<number> {
  assertBoundedFrontmatter(frontmatter);
  const fm = frontmatter as Record<string, string | string[]>;

  const lookupCache = new Map<string, string | null>();
  const lookup = async (canonical: string): Promise<string | null> => {
    if (lookupCache.has(canonical)) return lookupCache.get(canonical)!;
    const { data } = await sb
      .from("memory_entity")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("canonical_name", canonical)
      .limit(1)
      .maybeSingle();
    const id = (data as { id?: string } | null)?.id ?? null;
    lookupCache.set(canonical, id);
    return id;
  };

  const { resolved } = await extractFrontmatterLinks(fm, lookup);
  if (resolved.length === 0) return 0;

  const { error: delErr } = await sb
    .from("memory_relation")
    .delete()
    .eq("tenant_id", tenant_id)
    .eq("source_note_id", note_id)
    .in("link_source", ["extracted", "frontmatter"]);
  if (delErr) {
    console.warn(
      `[memory] frontmatter edges: DELETE-prior failed for note ${note_id}:`,
      delErr.message,
    );
  }

  const rows = resolved.map((r) => ({
    tenant_id,
    src_entity_id: r.fromEntityId,
    dst_entity_id: r.toEntityId,
    relation_type: r.relationType,
    link_source: r.linkSource,
    origin_field: r.originField,
    context: r.context,
    source_note_id: note_id,
  }));
  const { error: insErr } = await sb
    .from("memory_relation")
    .upsert(rows, {
      onConflict:
        "tenant_id,src_entity_id,dst_entity_id,relation_type,link_source,source_note_id",
      ignoreDuplicates: true,
    });
  if (insErr) {
    console.warn(
      `[memory] frontmatter edges: INSERT failed for note ${note_id}:`,
      insErr.message,
    );
    return 0;
  }
  return rows.length;
}

export type PersistTypedGraphResult = { entities: number; relations: number };

export async function persistTypedGraph(
  tenant_id: string,
  note_id: string,
  graph: TypedGraphResult,
): Promise<PersistTypedGraphResult> {
  const result: PersistTypedGraphResult = { entities: 0, relations: 0 };
  if (!graph || (graph.entities.length === 0 && graph.relations.length === 0)) {
    return result;
  }
  const sb = serviceClient();

  const idByCanon = new Map<string, string>();
  for (const e of graph.entities) {
    try {
      const { error: upErr } = await sb.from("memory_entity").upsert(
        {
          tenant_id,
          entity_type: e.type,
          canonical_name: e.canonical,
          attrs: {},
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,entity_type,canonical_name" },
      );
      if (upErr) {
        console.warn(
          `[memory] typed-graph: entity upsert failed for ${e.canonical} (${e.type}): ${upErr.message}`,
        );
        continue;
      }
      const { data: row } = await sb
        .from("memory_entity")
        .select("id")
        .eq("tenant_id", tenant_id)
        .eq("entity_type", e.type)
        .eq("canonical_name", e.canonical)
        .maybeSingle();
      const id = (row as { id?: string } | null)?.id;
      if (id) {
        idByCanon.set(e.canonical.toLowerCase(), id);
        result.entities += 1;
        const { error: mErr } = await sb.from("memory_note_entity").upsert(
          { tenant_id, note_id, entity_id: id },
          { onConflict: "tenant_id,note_id,entity_id", ignoreDuplicates: true },
        );
        if (mErr) {
          console.warn(
            `[memory] typed-graph: note_entity link failed for ${e.canonical}: ${mErr.message}`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[memory] typed-graph: entity persist threw for ${e.canonical}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  const relRows: Array<{
    tenant_id: string;
    src_entity_id: string;
    dst_entity_id: string;
    relation_type: string;
    link_source: string;
    source_note_id: string;
  }> = [];
  for (const r of graph.relations) {
    const srcId = idByCanon.get(r.from.toLowerCase());
    const dstId = idByCanon.get(r.to.toLowerCase());
    if (!srcId || !dstId || srcId === dstId) continue;
    relRows.push({
      tenant_id,
      src_entity_id: srcId,
      dst_entity_id: dstId,
      relation_type: r.type,
      link_source: "extracted",
      source_note_id: note_id,
    });
  }
  try {
    const { error: delErr } = await sb
      .from("memory_relation")
      .delete()
      .eq("tenant_id", tenant_id)
      .eq("source_note_id", note_id)
      .eq("link_source", "extracted");
    if (delErr) {
      console.warn(
        `[memory] typed-graph: DELETE-prior extracted edges failed for note ${note_id}: ${delErr.message}`,
      );
    }
    if (relRows.length === 0) return result;
    const { error: insErr } = await sb.from("memory_relation").upsert(relRows, {
      onConflict:
        "tenant_id,src_entity_id,dst_entity_id,relation_type,link_source,source_note_id",
      ignoreDuplicates: true,
    });
    if (insErr) {
      console.warn(
        `[memory] typed-graph: relation INSERT failed for note ${note_id}: ${insErr.message}`,
      );
      return result;
    }
    result.relations = relRows.length;
  } catch (err) {
    console.warn(
      `[memory] typed-graph: relation persist threw for note ${note_id}: ${(err as Error)?.message ?? err}`,
    );
  }
  return result;
}

export type SearchHit = {
  chunk_id: string;
  note_id: string;
  title: string;
  body: string;
  score: number;
  source?: string;
  note_type?: WriteNoteType;
  created_at?: string;
  trust_tier?: number | null;
  agent_slug?: string | null;
  thread_id?: string | null;
  conflict?: boolean;
};

export const CONFLICT_RECALL_LABEL =
  "Conflicting values on record: two saved notes disagree on this. Ask the user which is right before relying on either.";

export async function annotateOpenConflicts(
  tenant_id: string,
  hits: SearchHit[],
): Promise<SearchHit[]> {
  if (hits.length === 0) return hits;
  try {
    const sb = serviceClient();
    const ids = Array.from(new Set(hits.map((h) => h.note_id)));
    const list = ids.join(",");
    const { data, error } = await sb
      .from("memory_conflict_pair")
      .select("existing_note_id, new_note_id")
      .eq("tenant_id", tenant_id)
      .eq("status", "open")
      .or(`existing_note_id.in.(${list}),new_note_id.in.(${list})`)
      .limit(50);
    if (error || !data || data.length === 0) return hits;
    const inPair = new Set<string>();
    const partnerOf = new Map<string, string>();
    for (const p of data as Array<{ existing_note_id: string; new_note_id: string }>) {
      inPair.add(p.existing_note_id);
      inPair.add(p.new_note_id);
      partnerOf.set(p.existing_note_id, p.new_note_id);
      partnerOf.set(p.new_note_id, p.existing_note_id);
    }
    const label = (h: SearchHit): SearchHit => ({
      ...h,
      body: `${CONFLICT_RECALL_LABEL}\n${h.body}`,
      conflict: true,
    });
    const out = hits.map((h) => (inPair.has(h.note_id) ? label(h) : h));
    const have = new Set(ids);
    const missing = Array.from(
      new Set(ids.filter((id) => partnerOf.has(id)).map((id) => partnerOf.get(id)!)),
    ).filter((id) => !have.has(id));
    if (missing.length === 0) return out;
    const { data: notes } = await sb
      .from("memory_note")
      .select("id, title, body_markdown, source, note_type, created_at, trust_tier, agent_slug, thread_id")
      .eq("tenant_id", tenant_id)
      .in("id", missing)
      .is("superseded_by", null)
      .is("archived_at", null);
    const scoreOf = new Map(hits.map((h) => [h.note_id, h.score]));
    for (const n of (notes ?? []) as Array<{
      id: string;
      title: string;
      body_markdown: string;
      source: string;
      note_type: WriteNoteType;
      created_at: string;
      trust_tier: number | null;
      agent_slug: string | null;
      thread_id: string | null;
    }>) {
      const partner = partnerOf.get(n.id);
      out.push(
        label({
          chunk_id: n.id,
          note_id: n.id,
          title: n.title,
          body: n.body_markdown,
          score: (partner ? scoreOf.get(partner) : undefined) ?? 0,
          source: n.source,
          note_type: n.note_type,
          created_at: n.created_at,
          trust_tier: n.trust_tier,
          agent_slug: n.agent_slug,
          thread_id: n.thread_id,
        }),
      );
    }
    return out;
  } catch (e) {
    console.warn(`[memory] conflict annotation skipped: ${(e as Error).message}`);
    return hits;
  }
}

export async function searchMemory(
  tenant_id: string,
  query: string,
  k: number = 8,
  ctx?: {
    run_id?: string | null;
    agent_slug?: string | null;
    as_of_ts?: string | null;
    connector_keys?: string[] | null;
    benchOverride?: { reranker?: boolean } | null;
    deadline_at?: number | null;
  },
): Promise<SearchHit[]> {
  const startedAt = Date.now();
  if (!query || query.trim().length === 0) {
    recordSearchTrace({
      tenant_id,
      run_id: ctx?.run_id ?? null,
      agent_slug: ctx?.agent_slug ?? null,
      query,
      latency_ms: 0,
      status: "no_query",
    });
    return [];
  }
  let q_emb: number[] | null = null;
  let embedFailReason: string | null = null;
  try {
    q_emb = await embedOne(query, "query");
  } catch (e) {
    embedFailReason = (e as Error)?.message?.slice(0, 200) ?? "unknown";
    console.error(`[PRAXIS_EMBED_OUTAGE] query embed failed, falling back to keyword-only:`, e);
  }

  const ov = ctx?.benchOverride;
  const rerankerEnabled = ov ? (ov.reranker ?? false) : await isRerankerEnabledForTenant(tenant_id);
  const over_k = Math.min(k * 4, 50);

  const connectorPrefilter = toPrefilterArg(normalizeConnectorKeys(ctx?.connector_keys ?? []));
  const { data, error } = await serviceClient().rpc("memory_search_hybrid", {
    p_tenant_id: tenant_id,
    p_query: query,
    p_query_embedding: q_emb,
    p_limit: over_k,
    p_agent_slug: ctx?.agent_slug ?? null,
    p_connector_keys: connectorPrefilter,
  });
  if (error) {
    const lexRescueFitsBudget =
      !ctx?.deadline_at || Date.now() + LEX_RESCUE_RESERVE_MS <= ctx.deadline_at;
    const rescue = lexRescueFitsBudget
      ? toSearchHits(await runLexicalFallback(tenant_id, query, k))
      : [];
    recordSearchTrace({
      tenant_id,
      run_id: ctx?.run_id ?? null,
      agent_slug: ctx?.agent_slug ?? null,
      query,
      query_l2_norm: q_emb ? l2Norm(q_emb) : null,
      returned_count: rescue.length,
      latency_ms: Date.now() - startedAt,
      status: "rpc_error",
      error_code: error.message?.slice(0, 100) ?? "unknown",
      embedding_model: q_emb ? "voyage-3.5-lite" : null,
      embedding_dim: q_emb ? EMBED_DIM : null,
      retrieval_mode: rescue.length > 0 ? "lex_or" : q_emb ? "dense" : "lex_and",
      fallback_reason: rescue.length > 0 ? "rpc_error_lex_or_promoted" : null,
    });
    if (rescue.length > 0) return rescue;
    throw new Error(`memory_search_hybrid failed: ${error.message}`);
  }
  const hits = (data ?? []) as SearchHit[];
  if (hits.length === 0) {
    const fallback = await runLexicalFallback(tenant_id, query, k);
    const fallbackHits = toSearchHits(fallback);
    if (fallbackHits.length > 0) {
      fireAndForgetCapture({
        tenant_id,
        query,
        hits: fallbackHits,
        k,
        latency_ms: Date.now() - startedAt,
        run_id: ctx?.run_id ?? null,
        agent_slug: ctx?.agent_slug ?? null,
      });
      recordSearchTrace({
        tenant_id,
        run_id: ctx?.run_id ?? null,
        agent_slug: ctx?.agent_slug ?? null,
        query,
        query_l2_norm: q_emb ? l2Norm(q_emb) : null,
        lex_candidates: fallback.candidates,
        vec_candidates: 0,
        fused_count: fallbackHits.length,
        returned_count: fallbackHits.length,
        latency_ms: Date.now() - startedAt,
        status: "ok",
        error_code: embedFailReason,
        embedding_model: q_emb ? "voyage-3.5-lite" : null,
        embedding_dim: q_emb ? EMBED_DIM : null,
        retrieval_mode: "lex_or",
        fallback_reason: "primary_empty_lex_or_promoted",
        index_kind: "none",
        rank_components: { returned_notes: fallbackHits.map((h) => ({ id: h.note_id, score: h.score })) },
      });
      return fallbackHits;
    }

    fireAndForgetCapture({
      tenant_id,
      query,
      hits: [],
      k,
      latency_ms: Date.now() - startedAt,
      run_id: ctx?.run_id ?? null,
      agent_slug: ctx?.agent_slug ?? null,
    });
    recordSearchTrace({
      tenant_id,
      run_id: ctx?.run_id ?? null,
      agent_slug: ctx?.agent_slug ?? null,
      query,
      query_l2_norm: q_emb ? l2Norm(q_emb) : null,
      lex_candidates: 0,
      vec_candidates: 0,
      fused_count: 0,
      returned_count: 0,
      latency_ms: Date.now() - startedAt,
      status: "ok",
      error_code: embedFailReason,
      embedding_model: q_emb ? "voyage-3.5-lite" : null,
      embedding_dim: q_emb ? EMBED_DIM : null,
      retrieval_mode: q_emb ? "dense" : "lex_and",
      fallback_reason: embedFailReason ? "embed_fail_then_lex_or_empty" : "all_modes_empty",
      index_kind: "none",
    });
    return hits;
  }

  const note_ids = Array.from(new Set(hits.map((h) => h.note_id)));
  const { data: meta } = await serviceClient()
    .from("memory_note")
    .select(
      "id, source, note_type, created_at, trust_tier, agent_slug, thread_id, valid_from, valid_to",
    )
    .eq("tenant_id", tenant_id)
    .in("id", note_ids);
  const byId = new Map<
    string,
    {
      source: string;
      note_type: WriteNoteType;
      created_at: string;
      trust_tier: number | null;
      agent_slug: string | null;
      thread_id: string | null;
      valid_from: string | null;
      valid_to: string | null;
    }
  >();
  for (const row of (meta ?? []) as Array<{
    id: string;
    source: string;
    note_type: WriteNoteType;
    created_at: string;
    trust_tier: number | null;
    agent_slug: string | null;
    thread_id: string | null;
    valid_from: string | null;
    valid_to: string | null;
  }>) {
    byId.set(row.id, {
      source: row.source,
      note_type: row.note_type,
      created_at: row.created_at,
      trust_tier: row.trust_tier,
      agent_slug: row.agent_slug,
      thread_id: row.thread_id,
      valid_from: row.valid_from ?? null,
      valid_to: row.valid_to ?? null,
    });
  }
  const hydrated = hits.map((h) => {
    const m = byId.get(h.note_id);
    return m
      ? {
          ...h,
          source: m.source,
          note_type: m.note_type,
          created_at: m.created_at,
          trust_tier: m.trust_tier,
          agent_slug: m.agent_slug,
          thread_id: m.thread_id,
        }
      : h;
  });

  let working = hydrated;
  const asOfTs = ctx?.as_of_ts ?? null;
  if (asOfTs && Number.isFinite(Date.parse(asOfTs))) {
    const asOfMs = Date.parse(asOfTs);
    working = hydrated.filter((h) => {
      const m = byId.get(h.note_id);
      if (!m?.created_at) return true;
      if (Date.parse(m.created_at) > asOfMs) return false;
      return factHoldsAtValidTime(m.valid_from, m.valid_to, asOfMs);
    });
  }

  applyTrustTierPrecedence(working);
  let finalHits = working.slice(0, k);

  const baseHits = finalHits;
  let rerankEnabledTrace: boolean | null = null;
  let preRerankPoolSize: number | null = null;
  let rerankLatencyMs: number | null = null;
  let rerankStatus: RerankStatus | null = null;
  const rerankFitsBudget =
    !ctx?.deadline_at || Date.now() + RERANK_STAGE_MS <= ctx.deadline_at;
  if (rerankerEnabled && q_emb && !rerankFitsBudget) {
    rerankEnabledTrace = true;
    rerankStatus = "skipped_no_budget";
    finalHits = baseHits;
  } else if (rerankerEnabled && q_emb) {
    rerankEnabledTrace = true;
    const rerankStarted = Date.now();
    try {
      const pooled = await rerankPool(
        tenant_id,
        query,
        q_emb,
        k,
        ctx?.agent_slug ?? null,
        connectorPrefilter,
      );
      preRerankPoolSize = pooled.poolSize;
      if (pooled.hits.length > 0) {
        finalHits = pooled.hits;
        rerankStatus = "ok";
      } else {
        rerankStatus = "empty_pool";
        finalHits = baseHits;
      }
    } catch (e) {
      rerankStatus = (e as Error)?.name === "AbortError" ? "timeout" : "error";
      finalHits = baseHits;
      console.warn(
        `[memory] rerank ${rerankStatus} for tenant=${tenant_id}; serving baseHits:`,
        (e as Error)?.message,
      );
    } finally {
      rerankLatencyMs = Date.now() - rerankStarted;
    }
  }

  const [floorValue, resolvedIndexKind] = await Promise.all([
    getNumberSetting("memory_recall_floor", tenant_id).catch(() => 0),
    getStringSetting("memory_index_kind", tenant_id).catch(() => "none"),
  ]);
  let floorDropped = 0;
  if (rerankStatus === "ok" && floorValue > 0) {
    const kept = applyRelevanceFloor(finalHits, floorValue);
    floorDropped = finalHits.length - kept.length;
    finalHits = kept;
  }
  finalHits = await annotateOpenConflicts(tenant_id, finalHits);
  const indexKind: "none" | "ivfflat" | "hnsw" =
    resolvedIndexKind === "ivfflat" || resolvedIndexKind === "hnsw" ? resolvedIndexKind : "none";

  if (!ov) {
  fireAndForgetCapture({
    tenant_id,
    query,
    hits: finalHits,
    k,
    latency_ms: Date.now() - startedAt,
    run_id: ctx?.run_id ?? null,
    agent_slug: ctx?.agent_slug ?? null,
  });

  recordSearchTrace({
    tenant_id,
    run_id: ctx?.run_id ?? null,
    agent_slug: ctx?.agent_slug ?? null,
    query,
    query_l2_norm: q_emb ? l2Norm(q_emb) : null,
    lex_candidates: hits.length,
    vec_candidates: q_emb ? hits.length : 0,
    fused_count: hits.length,
    returned_count: finalHits.length,
    latency_ms: Date.now() - startedAt,
    status: "ok",
    error_code: embedFailReason,
    embedding_model: q_emb ? "voyage-3.5-lite" : null,
    embedding_dim: q_emb ? EMBED_DIM : null,
    retrieval_mode: rerankStatus === "ok" ? "rerank" : q_emb ? "dense" : "lex_and",
    fallback_reason:
      rerankStatus && rerankStatus !== "ok"
        ? `rerank_${rerankStatus}`
        : embedFailReason
          ? "embed_fail_keyword_only"
          : null,
    index_kind: indexKind,
    rerank_enabled: rerankEnabledTrace,
    pre_rerank_pool_size: preRerankPoolSize,
    rerank_latency_ms: rerankLatencyMs,
    rerank_status: rerankStatus,
    rerank_model: rerankEnabledTrace ? RERANK_MODEL_NAME : null,
    rank_components: {
      ...(floorValue > 0 ? { floor_value: floorValue, floor_dropped: floorDropped } : {}),
      returned_notes: finalHits.map((h) => ({ id: h.note_id, score: h.score })),
    },
  });
  }

  return finalHits;
}

async function rerankPool(
  tenant_id: string,
  query: string,
  q_emb: number[],
  k: number,
  agent_slug: string | null,
  connector_keys: string[] | null,
): Promise<{ hits: SearchHit[]; poolSize: number }> {
  const { data, error } = await serviceClient().rpc("memory_search_hybrid_v2", {
    p_tenant_id: tenant_id,
    p_query: query,
    p_query_embedding: q_emb,
    p_limit: RERANK_POOL_K,
    p_agent_slug: agent_slug,
    p_connector_keys: connector_keys,
  });
  if (error) throw new Error(`memory_search_hybrid_v2 failed: ${error.message}`);
  const pool = (data ?? []) as SearchHit[];
  if (pool.length === 0) return { hits: [], poolSize: 0 };

  const docs = pool.map((h) =>
    `${h.title}\n\n${h.body}`.slice(0, RERANK_MAX_DOC_CHARS),
  );
  const ranked = await rerankDocuments(query, docs, pool.length);

  const rerankedHits: SearchHit[] = [];
  for (const r of ranked) {
    if (!Number.isInteger(r.index) || r.index < 0 || r.index >= pool.length) continue;
    const h = pool[r.index];
    if (h) rerankedHits.push({ ...h, score: r.relevance_score });
  }
  if (rerankedHits.length === 0) return { hits: [], poolSize: pool.length };

  const note_ids = Array.from(new Set(rerankedHits.map((h) => h.note_id)));
  const { data: meta } = await serviceClient()
    .from("memory_note")
    .select("id, source, note_type, created_at, trust_tier, agent_slug, thread_id")
    .eq("tenant_id", tenant_id)
    .in("id", note_ids);
  const byId = new Map<
    string,
    {
      source: string;
      note_type: WriteNoteType;
      created_at: string;
      trust_tier: number | null;
      agent_slug: string | null;
      thread_id: string | null;
    }
  >();
  for (const row of (meta ?? []) as Array<{
    id: string;
    source: string;
    note_type: WriteNoteType;
    created_at: string;
    trust_tier: number | null;
    agent_slug: string | null;
    thread_id: string | null;
  }>) {
    byId.set(row.id, {
      source: row.source,
      note_type: row.note_type,
      created_at: row.created_at,
      trust_tier: row.trust_tier,
      agent_slug: row.agent_slug,
      thread_id: row.thread_id,
    });
  }
  const hydrated: SearchHit[] = [];
  for (const h of rerankedHits) {
    const m = byId.get(h.note_id);
    if (!m) continue;
    hydrated.push({
      ...h,
      source: m.source,
      note_type: m.note_type,
      created_at: m.created_at,
      trust_tier: m.trust_tier,
      agent_slug: m.agent_slug,
      thread_id: m.thread_id,
    });
  }
  applyTrustTierPrecedence(hydrated);
  return { hits: hydrated.slice(0, k), poolSize: pool.length };
}

export { loadRecentFeedbackForAgent, type FeedbackNoteRow } from "./feedback-recall";

export async function deleteNote(
  tenant_id: string,
  note_id: string,
  actor_user_id?: string | null,
  reason?: string | null,
): Promise<void> {
  const sb = serviceClient();

  const { data: slugRow } = await sb
    .from("memory_note")
    .select("slug, title, source, note_type, trust_tier, created_at, updated_at")
    .eq("id", note_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (slugRow && (slugRow as { slug: string | null }).slug) {
    throw new Error(
      `cannot delete anchor (slug=${(slugRow as { slug: string }).slug}); anchors are rewritable via upsertAnchor, not deletable`,
    );
  }

  const { data, error } = await sb
    .from("memory_note")
    .delete()
    .eq("id", note_id)
    .eq("tenant_id", tenant_id)
    .select("id");
  if (error) throw new Error(`memory_note delete failed: ${error.message}`);
  if (!data || data.length === 0) {
    throw new NoteNotFoundError(tenant_id, note_id);
  }

  const snap = (slugRow ?? { id: note_id }) as Record<string, unknown>;
  await writeMutationAudit({
    tenant_id,
    note_id,
    action: "delete",
    actor_user_id: actor_user_id ?? null,
    reason: reason ?? null,
    before_snapshot: buildDeleteSnapshot({ id: note_id, ...snap }),
  });
}

export async function deleteNotesBySourceRef(
  tenant_id: string,
  source: WriteNoteSource,
  source_ref: string,
  actor_user_id?: string | null,
): Promise<number> {
  const { data, error } = await serviceClient()
    .from("memory_note")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("source", source)
    .eq("source_ref", source_ref);
  if (error) throw new Error(`memory_note lookup failed: ${error.message}`);
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  for (const id of ids) await deleteNote(tenant_id, id, actor_user_id ?? null, "feedback replaced");
  return ids.length;
}

export type NoteRow = {
  id: string;
  title: string;
  body_markdown: string;
  source: string;
  source_ref: string | null;
  tags: string[];
  note_type: WriteNoteType | "anchor";
  slug: string | null;
  created_at: string;
  updated_at: string;
};

export async function listNotes(
  tenant_id: string,
  opts: {
    limit?: number;
    tag?: string;
    note_type?: WriteNoteType;
    includeSuperseded?: boolean;
    sources?: readonly WriteNoteSource[];
  } = {},
): Promise<NoteRow[]> {
  let q = serviceClient()
    .from("memory_note")
    .select("id, title, body_markdown, source, source_ref, tags, note_type, slug, created_at, updated_at")
    .eq("tenant_id", tenant_id)
    .neq("source", "agent_discovery_inferred")
    .is("archived_at", null);
  if (!opts.includeSuperseded) q = q.is("superseded_by", null);
  if (opts.tag) q = q.contains("tags", [opts.tag]);
  if (opts.note_type) q = q.eq("note_type", opts.note_type);
  if (opts.sources && opts.sources.length > 0) q = q.in("source", opts.sources as string[]);
  q = q.order("updated_at", { ascending: false }).limit(opts.limit ?? 100);
  const { data, error } = await q;
  if (error) throw new Error(`listNotes failed: ${error.message}`);
  return (data ?? []) as NoteRow[];
}

export async function getNote(tenant_id: string, note_id: string): Promise<NoteRow | null> {
  const { data, error } = await serviceClient()
    .from("memory_note")
    .select("id, title, body_markdown, source, source_ref, tags, note_type, slug, created_at, updated_at")
    .eq("id", note_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(`getNote failed: ${error.message}`);
  return (data as NoteRow | null) ?? null;
}

export type ConflictPair = {
  active_id: string;
  active_title: string;
  active_body: string;
  superseded_id: string;
  superseded_title: string;
  superseded_body: string;
  supersession_rationale: string | null;
  superseded_at: string;
};

export async function listConflicts(
  tenant_id: string,
  limit: number = 50,
): Promise<ConflictPair[]> {
  const sb = serviceClient();
  const { data: supersededData, error: supErr } = await sb
    .from("memory_note")
    .select("id, title, body_markdown, superseded_by, supersession_rationale, superseded_at")
    .eq("tenant_id", tenant_id)
    .not("superseded_by", "is", null)
    .order("superseded_at", { ascending: false })
    .limit(limit);
  if (supErr) throw new Error(`listConflicts (superseded) failed: ${supErr.message}`);
  const superseded = (supersededData ?? []) as Array<{
    id: string;
    title: string;
    body_markdown: string;
    superseded_by: string;
    supersession_rationale: string | null;
    superseded_at: string;
  }>;
  if (superseded.length === 0) return [];

  const activeIds = Array.from(new Set(superseded.map((r) => r.superseded_by)));
  const { data: activeData } = await sb
    .from("memory_note")
    .select("id, title, body_markdown")
    .eq("tenant_id", tenant_id)
    .in("id", activeIds);
  const byId = new Map<string, { id: string; title: string; body_markdown: string }>();
  for (const r of (activeData ?? []) as Array<{
    id: string;
    title: string;
    body_markdown: string;
  }>) {
    byId.set(r.id, r);
  }
  return superseded
    .map((s) => {
      const a = byId.get(s.superseded_by);
      if (!a) return null;
      return {
        active_id: a.id,
        active_title: a.title,
        active_body: a.body_markdown,
        superseded_id: s.id,
        superseded_title: s.title,
        superseded_body: s.body_markdown,
        supersession_rationale: s.supersession_rationale,
        superseded_at: s.superseded_at,
      };
    })
    .filter((x): x is ConflictPair => x !== null);
}

export type DreamCycleStatus = {
  last_run_at: string | null;
  next_run_at: string;
  schedule_human: string;
};

const DREAM_CYCLE_CRON_UTC_HOUR = 11;
const DREAM_CYCLE_CRON_UTC_MINUTE = 30;
const DREAM_CYCLE_SCHEDULE_HUMAN = "every night at 3:30 AM PT";

export function nextDreamCycleRunAt(now: Date = new Date()): string {
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      DREAM_CYCLE_CRON_UTC_HOUR,
      DREAM_CYCLE_CRON_UTC_MINUTE,
      0,
      0,
    ),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

export async function getDreamCycleStatus(tenant_id: string): Promise<DreamCycleStatus> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("dream_cycle_runs")
    .select("last_completed_at")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(`getDreamCycleStatus failed: ${error.message}`);
  const last = (data as { last_completed_at: string | null } | null)?.last_completed_at ?? null;
  return {
    last_run_at: last,
    next_run_at: nextDreamCycleRunAt(),
    schedule_human: DREAM_CYCLE_SCHEDULE_HUMAN,
  };
}

export async function unsupersedeNote(tenant_id: string, note_id: string): Promise<void> {
  const { error } = await serviceClient().rpc("unsupersede_memory_note", {
    p_tenant_id: tenant_id,
    p_note_id: note_id,
  });
  if (error) throw new Error(`unsupersede failed: ${error.message}`);
}

export type NeighborHit = {
  note_id: string;
  title: string;
  body_markdown: string;
  note_type: WriteNoteType;
  cosine: number;
  created_at: string;
};

export type TenantEntityHint = {
  entity_type: string;
  canonical_name: string;
};

export type EntityWithMentions = {
  entity_id: string;
  entity_type: string;
  canonical_name: string;
  attrs: Record<string, unknown>;
  notes: Array<{
    note_id: string;
    title: string;
    body_markdown: string;
    note_type: WriteNoteType;
    source: string;
    created_at: string;
  }>;
};

export async function loadTenantEntityHints(tenant_id: string): Promise<TenantEntityHint[]> {
  const { data, error } = await serviceClient()
    .from("memory_entity")
    .select("entity_type, canonical_name")
    .eq("tenant_id", tenant_id)
    .order("last_seen_at", { ascending: false })
    .limit(500);
  if (error) {
    console.warn(`[memory] loadTenantEntityHints failed: ${error.message}`);
    return [];
  }
  return ((data ?? []) as TenantEntityHint[]).filter(
    (h) => h.canonical_name && h.canonical_name.length >= 2,
  );
}

export async function loadEntityContext(
  tenant_id: string,
  hits: Array<{ entity_type: string; canonical_name: string }>,
  opts: { perEntityNoteLimit?: number; totalCharBudget?: number } = {},
): Promise<EntityWithMentions[]> {
  if (hits.length === 0) return [];
  const sb = serviceClient();
  const perEntity = opts.perEntityNoteLimit ?? 5;
  const budget = opts.totalCharBudget ?? 5000;

  const orParts = hits
    .map(
      (h) =>
        `and(entity_type.eq.${h.entity_type},canonical_name.eq.${h.canonical_name.replace(/[(),]/g, "")})`,
    )
    .join(",");
  const { data: entityRows } = await sb
    .from("memory_entity")
    .select("id, entity_type, canonical_name, attrs")
    .eq("tenant_id", tenant_id)
    .or(orParts);
  const entities = ((entityRows ?? []) as Array<{
    id: string;
    entity_type: string;
    canonical_name: string;
    attrs: Record<string, unknown> | null;
  }>).map((e) => ({
    entity_id: e.id,
    entity_type: e.entity_type,
    canonical_name: e.canonical_name,
    attrs: e.attrs ?? {},
    notes: [] as EntityWithMentions["notes"],
  }));
  if (entities.length === 0) return [];

  const entityIds = entities.map((e) => e.entity_id);
  const { data: mentionRows } = await sb
    .from("memory_note_entity")
    .select(
      "entity_id, note_id, memory_note!inner(id, title, body_markdown, note_type, source, created_at, superseded_by)",
    )
    .eq("tenant_id", tenant_id)
    .in("entity_id", entityIds);

  type EmbeddedNote = {
    id: string;
    title: string;
    body_markdown: string;
    note_type: WriteNoteType;
    source: string;
    created_at: string;
    superseded_by: string | null;
  };
  const byEntity = new Map<string, EntityWithMentions["notes"]>();
  for (const row of (mentionRows ?? []) as unknown as Array<{
    entity_id: string;
    note_id: string;
    memory_note: EmbeddedNote | EmbeddedNote[] | null;
  }>) {
    const raw = row.memory_note;
    const n: EmbeddedNote | null = Array.isArray(raw) ? raw[0] ?? null : raw;
    if (!n || n.superseded_by) continue;
    if (PRIVATE_NOTE_TYPE_SET.has(n.note_type)) continue;
    const list = byEntity.get(row.entity_id) ?? [];
    list.push({
      note_id: n.id,
      title: n.title,
      body_markdown: n.body_markdown,
      note_type: n.note_type,
      source: n.source,
      created_at: n.created_at,
    });
    byEntity.set(row.entity_id, list);
  }
  for (const e of entities) {
    const all = byEntity.get(e.entity_id) ?? [];
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    e.notes = all.slice(0, perEntity);
  }

  let used = 0;
  for (const e of entities) {
    used += e.canonical_name.length + 40;
    for (const n of e.notes) used += n.title.length + n.body_markdown.length + 20;
  }
  while (used > budget && entities.some((e) => e.notes.length > 0)) {
    let oldestEntity: EntityWithMentions | null = null;
    let oldestAt = "9999";
    for (const e of entities) {
      const last = e.notes[e.notes.length - 1];
      if (last && last.created_at < oldestAt) {
        oldestAt = last.created_at;
        oldestEntity = e;
      }
    }
    if (!oldestEntity) break;
    const dropped = oldestEntity.notes.pop();
    if (!dropped) break;
    used -= dropped.title.length + dropped.body_markdown.length + 20;
  }

  return entities.filter((e) => e.notes.length > 0 || Object.keys(e.attrs).length > 0);
}

export async function findNearestNeighbors(
  tenant_id: string,
  query_embedding: number[],
  opts: {
    limit?: number;
    minCosine?: number;
    noteType?: WriteNoteType;
    excludeNoteId?: string;
  } = {},
): Promise<NeighborHit[]> {
  const { data, error } = await serviceClient().rpc("memory_nearest_neighbors", {
    p_tenant_id: tenant_id,
    p_query_embedding: query_embedding,
    p_limit: opts.limit ?? 5,
    p_min_cosine: opts.minCosine ?? 0.75,
    p_note_type: opts.noteType ?? null,
    p_exclude_note_id: opts.excludeNoteId ?? null,
  });
  if (error) throw new Error(`memory_nearest_neighbors failed: ${error.message}`);
  return (data ?? []) as NeighborHit[];
}
