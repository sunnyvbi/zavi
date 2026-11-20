
import { z } from "zod";
import { MEMORY_SLUGS } from "@/services/memory/loader";
import { generateRefinedAnchorPreview } from "@/services/memory/generate-anchors";
import { ExpectedToolError } from "../types";
import { isHumanAuthoredChat } from "@/services/agents/untrusted-context";
import type { ToolSpec } from "../types";
import { hashBody, stashPending } from "./_anchor-pending";

const inputSchema = z.object({
  slug: z.enum(MEMORY_SLUGS).describe("The brain anchor to refine."),
  refine_instruction: z
    .string()
    .min(1)
    .max(5000)
    .describe("Verbatim words from the operator describing the correction or update."),
});

export const brainRefineAnchorTool: ToolSpec = {
  name: "brain_refine_anchor",
  effect: "write",
  description:
    "Draft a refinement to a canonical business brain anchor (company, ops, policies, disputes, support) " +
    "using the operator's instructions. Generates a PREVIEW of the new content but does NOT persist it. " +
    "Use this when the operator gives a correction to core business knowledge. You MUST echo the preview to " +
    "the operator and ask them to confirm; once they confirm, call brain_apply_anchor to persist it.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);

    if (!isHumanAuthoredChat(ctx)) {
      throw new ExpectedToolError(
        "brain_refine_anchor_denied",
        "Brain anchors can only be refined during a live chat session with a human operator.",
      );
    }
    if (!ctx.chat_thread_id) {
      throw new ExpectedToolError(
        "brain_refine_anchor_no_thread",
        "Brain refinement needs a chat thread context to stage the confirmation.",
      );
    }

    try {
      const preview = await generateRefinedAnchorPreview({
        tenant_id: ctx.tenant_id,
        slug: args.slug,
        refineInstruction: args.refine_instruction,
      });

      await stashPending(ctx.tenant_id, ctx.chat_thread_id, {
        slug: args.slug,
        proposed_body: preview.body_markdown,
        key_facts: preview.key_facts,
        metadata: preview.metadata,
        hash: hashBody(preview.body_markdown),
        run_id: ctx.run_id ?? null,
        created_at: new Date().toISOString(),
      });

      return {
        slug: preview.slug,
        body_markdown: preview.body_markdown,
        key_facts: preview.key_facts,
        awaiting_confirmation: true,
      };
    } catch (e) {
      if (e instanceof ExpectedToolError) throw e;
      console.error(`brain.refine_anchor failed for ${args.slug}:`, e);
      throw new ExpectedToolError(
        "brain_refine_anchor_failed",
        `Failed to generate a refinement for ${args.slug}. Try again with simpler instructions.`,
      );
    }
  },
};
