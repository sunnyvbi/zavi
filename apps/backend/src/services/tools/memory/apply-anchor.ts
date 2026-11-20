
import { z } from "zod";
import { upsertAnchor } from "@/services/memory/upsert-anchor";
import { ExpectedToolError } from "../types";
import { isHumanAuthoredChat } from "@/services/agents/untrusted-context";
import type { ToolSpec } from "../types";
import {
  clearPending,
  hashBody,
  isPendingFresh,
  readPending,
  supersedeContradictingDerivedNotes,
} from "./_anchor-pending";

const inputSchema = z.object({
  confirm: z
    .boolean()
    .describe("Must be true — set this only after the operator has explicitly confirmed the previewed change."),
});

async function readCompanyNoteId(tenant_id: string): Promise<string | null> {
  try {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { data } = await tenantClient(asTenantId(tenant_id))
      .from("memory_note")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("slug", "company")
      .is("superseded_by", null)
      .maybeSingle();
    return (data as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

export const brainApplyAnchorTool: ToolSpec = {
  name: "brain_apply_anchor",
  effect: "destructive",
  description:
    "Persist the brain-anchor correction the operator previewed and confirmed. Call this ONLY after you " +
    "showed the operator the brain_refine_anchor preview and they explicitly confirmed. It applies the exact " +
    "previewed content — you do not supply the body. If no confirmed preview is pending, it is a no-op.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);

    if (!isHumanAuthoredChat(ctx)) {
      throw new ExpectedToolError(
        "brain_apply_anchor_denied",
        "Brain anchors can only be applied during a live chat session with a human operator.",
      );
    }
    if (!ctx.chat_thread_id) {
      throw new ExpectedToolError(
        "brain_apply_anchor_no_thread",
        "Brain apply needs a chat thread context.",
      );
    }
    if (!args.confirm) {
      throw new ExpectedToolError(
        "brain_apply_anchor_not_confirmed",
        "confirm must be true — only call this after the operator confirms.",
      );
    }

    const pending = await readPending(ctx.tenant_id, ctx.chat_thread_id);
    if (!pending) {
      throw new ExpectedToolError(
        "brain_apply_anchor_nothing_pending",
        "There is no pending brain correction to apply. Draft one with brain_refine_anchor first.",
      );
    }
    if (!isPendingFresh(pending)) {
      await clearPending(ctx.tenant_id, ctx.chat_thread_id);
      throw new ExpectedToolError(
        "brain_apply_anchor_stale",
        "The previewed change expired. Ask the operator to restate the correction so we can re-draft it.",
      );
    }
    if (pending.run_id && ctx.run_id && pending.run_id === ctx.run_id) {
      throw new ExpectedToolError(
        "brain_apply_anchor_same_turn",
        "Echo the preview to the operator and apply only after they confirm on a later turn.",
      );
    }
    if (hashBody(pending.proposed_body) !== pending.hash) {
      await clearPending(ctx.tenant_id, ctx.chat_thread_id);
      throw new ExpectedToolError(
        "brain_apply_anchor_corrupt",
        "The pending draft failed its integrity check. Please re-draft the correction.",
      );
    }

    if (pending.slug === "company") {
      const { writeCompanyProse } = await import("@/services/company/brief");
      const stored = await writeCompanyProse(
        ctx.tenant_id,
        pending.proposed_body,
        "founder",
        "brain_apply_anchor (operator-confirmed in chat)",
      );
      if (!stored.stored && stored.reason === "error") {
        throw new ExpectedToolError(
          "brain_apply_anchor_write_failed",
          `The correction could not be saved: ${stored.error}. Your wording is still pending, so it can be applied again.`,
        );
      }
      if (!stored.stored) {
        throw new ExpectedToolError(
          "brain_apply_anchor_outranked",
          "Not applied: the company brief is generated from the company record, and the write did " +
            "not land. Your wording is still pending, so it can be applied again. If it keeps " +
            "failing, change it on the Company Details card instead.",
        );
      }
      await clearPending(ctx.tenant_id, ctx.chat_thread_id);

      const companyNoteId = await readCompanyNoteId(ctx.tenant_id);
      const retired = companyNoteId
        ? await supersedeContradictingDerivedNotes(
            ctx.tenant_id,
            "company",
            companyNoteId,
            pending.proposed_body,
          )
        : 0;

      return {
        slug: pending.slug,
        applied: true,
        note_id: companyNoteId,
        stale_notes_retired: retired,
      };
    }

    const write = await upsertAnchor({
      tenant_id: ctx.tenant_id,
      slug: pending.slug,
      title: `${pending.slug}.md`,
      body_markdown: pending.proposed_body,
      source: "agent_write",
      metadata: pending.metadata ?? {},
    });

    const retired = await supersedeContradictingDerivedNotes(
      ctx.tenant_id,
      pending.slug,
      write.note_id,
      pending.proposed_body,
    );

    await clearPending(ctx.tenant_id, ctx.chat_thread_id);

    return {
      slug: pending.slug,
      applied: true,
      note_id: write.note_id,
      stale_notes_retired: retired,
    };
  },
};
