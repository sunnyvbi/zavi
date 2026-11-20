
import { serviceClient } from "@/services/supabase";
import { upsertAnchor, upsertAnchorGuarded } from "@/services/memory/upsert-anchor";
import { projectCompanyFactValue } from "@/services/company/facts";
import { DISCOVERY_OWNED_SOURCES } from "@/services/tools/discovery/write-anchor";
import { MEMORY_SLUGS, type MemoryDocSlug } from "@/services/memory/loader";
import { buildEditSnapshot, writeMutationAudit } from "@/services/memory/mutation-audit";

export type PromoteResult =
  | { ok: true; slug: MemoryDocSlug; note_id: string; forced: boolean }
  | { ok: false; code: "no_draft"; message: string }
  | { ok: false; code: "protected_anchor"; message: string; existing_source: string }
  | { ok: false; code: "render_failed"; message: string; existing_source: string };

export function isCanonicalSlug(s: string): s is MemoryDocSlug {
  return (MEMORY_SLUGS as readonly string[]).includes(s);
}

export const PROMOTE_OVERWRITABLE_SOURCES = [
  ...DISCOVERY_OWNED_SOURCES,
  "agent_write",
] as const;

export async function promoteDiscoveryDraft(params: {
  tenant_id: string;
  slug: MemoryDocSlug;
  force?: boolean;
  actor_user_id?: string | null;
  via?: "human" | "judge";
  judge_reason?: string;
}): Promise<PromoteResult> {
  const { tenant_id, slug, actor_user_id = null, via = "human", judge_reason } = params;
  const force = via === "judge" ? false : (params.force ?? false);
  const sb = serviceClient();
  const draftSlug = `${slug}__inferred`;

  const { data: draftRow, error: dErr } = await sb
    .from("memory_note")
    .select("id, title, body_markdown, source, metadata")
    .eq("tenant_id", tenant_id)
    .eq("slug", draftSlug)
    .eq("source", "agent_discovery_inferred")
    .is("superseded_by", null)
    .maybeSingle();
  if (dErr) throw new Error(`promote: draft read failed for ${draftSlug}: ${dErr.message}`);
  const draft = draftRow as {
    id: string;
    title: string | null;
    body_markdown: string | null;
    metadata: Record<string, unknown> | null;
  } | null;
  if (!draft) {
    return { ok: false, code: "no_draft", message: `No discovery draft to promote for '${slug}'.` };
  }

  const { data: existingRow } = await sb
    .from("memory_note")
    .select("id, title, body_markdown, source")
    .eq("tenant_id", tenant_id)
    .eq("slug", slug)
    .is("superseded_by", null)
    .maybeSingle();
  const existing = existingRow as {
    id: string;
    title: string | null;
    body_markdown: string | null;
    source: string | null;
  } | null;

  const metadata = {
    ...(draft.metadata ?? {}),
    promoted: {
      from_draft_note_id: draft.id,
      promoted_at: new Date().toISOString(),
      promoted_by: actor_user_id,
      via,
      forced: force,
      ...(via === "judge" && judge_reason ? { judge_reason } : {}),
      ...(existing?.source ? { replaced_source: existing.source } : {}),
    },
  };

  const promotedSource = via === "judge" ? "agent_discovery_verified" : "praxis_staff";

  const input = {
    tenant_id,
    slug,
    title: `${slug}.md`,
    body_markdown: draft.body_markdown ?? "",
    source: promotedSource as "praxis_staff" | "agent_discovery_verified",
    metadata,
  };

  if (slug === "company") {
    const beforeWrite = new Date().toISOString();
    const promoted = await projectCompanyFactValue(
      tenant_id,
      "company_story",
      draft.body_markdown ?? "",
      "onboarding_enrichment",
      `promoted discovery draft ${draft.id} (${via})`,
    );
    if (!promoted.written) {
      return {
        ok: false,
        code: "protected_anchor",
        message:
          `The company brief is generated from the company record, and its story is ` +
          `held by a higher-ranked source${promoted.error ? ` (${promoted.error})` : ""}. ` +
          `Edit it on the Company Details card instead.`,
        existing_source: existing?.source ?? "unknown",
      } as PromoteResult;
    }
    const { data: briefRow } = await sb
      .from("memory_note")
      .select("id, metadata")
      .eq("tenant_id", tenant_id)
      .eq("slug", "company")
      .is("superseded_by", null)
      .maybeSingle();
    const brief = briefRow as { id?: string; metadata?: { rendered_at?: string } } | null;

    const renderedAt = brief?.metadata?.rendered_at;
    if (!brief?.id || !renderedAt || renderedAt < beforeWrite) {
      return {
        ok: false,
        code: "render_failed",
        message:
          "The story was saved to the company record, but the brief could not be rebuilt from it, " +
          "so the draft has been left in the queue. Try again.",
        existing_source: existing?.source ?? "unknown",
      } as PromoteResult;
    }
    const briefNoteId = brief.id;

    if (existing) {
      await writeMutationAudit({
        tenant_id,
        note_id: existing.id,
        action: "edit",
        actor_user_id,
        reason: `promote of discovery draft into the company record's story`,
        before_snapshot: buildEditSnapshot({
          id: existing.id,
          title: existing.title,
          body_markdown: existing.body_markdown,
          source: existing.source,
        } as Parameters<typeof buildEditSnapshot>[0]),
      });
    }
    await sb
      .from("memory_note")
      .update({
        superseded_by: briefNoteId || null,
        superseded_at: new Date().toISOString(),
      })
      .eq("id", draft.id);

    return { ok: true, slug, note_id: briefNoteId, forced: force };
  }

  const written = force
    ? await upsertAnchor(input)
    : await upsertAnchorGuarded(input, PROMOTE_OVERWRITABLE_SOURCES);

  if (!written) {
    return {
      ok: false,
      code: "protected_anchor",
      message:
        `'${slug}' is held by a protected anchor (source: ${existing?.source ?? "unknown"}) ` +
        `and was NOT overwritten. Only a human-authored anchor is protected now — ` +
        `re-send with force:true to deliberately replace it.`,
      existing_source: existing?.source ?? "unknown",
    };
  }

  if (existing) {
    await writeMutationAudit({
      tenant_id,
      note_id: existing.id,
      action: "edit",
      actor_user_id,
      reason: force
        ? `FORCED promote of discovery draft over a ${existing.source} anchor`
        : `promote of discovery draft`,
      before_snapshot: buildEditSnapshot({
        id: existing.id,
        title: existing.title,
        body_markdown: existing.body_markdown,
        source: existing.source,
      } as Parameters<typeof buildEditSnapshot>[0]),
    });
  }

  await sb
    .from("memory_note")
    .update({ superseded_by: written.note_id, superseded_at: new Date().toISOString() })
    .eq("id", draft.id);

  return { ok: true, slug, note_id: written.note_id, forced: force };
}
