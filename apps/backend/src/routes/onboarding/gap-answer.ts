
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { upsertAnchor } from "@/services/memory/upsert-anchor";
import {
  BRAIN_SLOT_SLUGS,
  BRAIN_SLOT_TITLES,
  sanitizeGapAnswer,
  scoreSlot,
  type BrainSlotSlug,
  type SlotStatus,
} from "@/services/memory/brain-slots";

const Body = z.object({
  slug: z.enum(BRAIN_SLOT_SLUGS),
  answer: z.string().min(1).max(4000),
});

export async function onboardingGapAnswer(
  req: Request,
  res: Response,
): Promise<void> {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body);
  } catch (e) {
    res.status(400).json({
      error: { code: "validation", message: e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message },
    });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const slug = body.slug as BrainSlotSlug;

  const answer = sanitizeGapAnswer(body.answer);
  if (answer.length === 0) {
    res.status(422).json({
      error: {
        code: "empty_after_sanitize",
        message: "Answer was empty after removing control markup.",
      },
    });
    return;
  }

  const sb = serviceClient();
  const { data: existingRow, error: readErr } = await sb
    .from("memory_note")
    .select("metadata")
    .eq("tenant_id", auth.tenant_id)
    .eq("slug", slug)
    .eq("note_type", "anchor")
    .is("superseded_by", null)
    .maybeSingle();
  if (readErr) {
    res.status(500).json({
      error: { code: "slot_read_failed", message: readErr.message },
    });
    return;
  }
  const existingMeta = (existingRow?.metadata ?? {}) as Record<string, unknown>;
  const priorProvenance = Array.isArray(existingMeta.provenance)
    ? (existingMeta.provenance as unknown[]).filter(
        (p): p is string => typeof p === "string",
      )
    : [];

  const nowIso = new Date().toISOString();
  const mergedMeta: Record<string, unknown> = {
    ...existingMeta,
    completeness: 2,
    provenance: [
      ...priorProvenance.filter((p) => p !== "gap_answer"),
      "gap_answer",
    ],
    scored_at: nowIso,
  };
  delete mergedMeta.seed_kind;

  const title = `# ${BRAIN_SLOT_TITLES[slug]}`;

  try {
    if (slug === "company") {
      const { writeCompanyProse } = await import("@/services/company/brief");
      const stored = await writeCompanyProse(
        auth.tenant_id,
        answer,
        "founder",
        `onboarding gap answer (user ${auth.user_id})`,
      );
      if (!stored.stored) {
        res.status(500).json({
          error: {
            code: "slot_write_failed",
            message: "Could not save your company description. Try again.",
          },
        });
        return;
      }
    } else {
      await upsertAnchor({
        tenant_id: auth.tenant_id,
        slug,
        title,
        body_markdown: answer,
        source: "human",
        metadata: mergedMeta,
      });
    }
  } catch (e) {
    res.status(500).json({
      error: { code: "slot_write_failed", message: (e as Error).message },
    });
    return;
  }

  const status: SlotStatus = scoreSlot(answer, mergedMeta);
  res.json({ ok: true, slot: { slug, status } });
}
