
import { z } from "zod";
import { ExpectedToolError } from "../types";
import { isHumanAuthoredChat } from "@/services/agents/untrusted-context";
import type { ToolSpec } from "../types";
import { retireNotesByDescription } from "./_anchor-pending";

const inputSchema = z.object({
  description: z
    .string()
    .min(1)
    .max(2000)
    .describe("The operator's description of the wrong/stale note(s) to retire, in their own words."),
});

export const brainRetireNoteTool: ToolSpec = {
  name: "brain_retire_note",
  effect: "write",
  description:
    "Retire (remove) a wrong or stale note from the business brain when the operator asks you to delete/forget " +
    "a specific fact. Describe the note(s) using the operator's words; it conservatively matches and retires " +
    "only clearly-matching notes (reversible). Does NOT touch the 5 canonical anchors — use brain_apply_anchor " +
    "for those. Report back honestly exactly which notes were retired (the tool returns their titles).",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);

    if (!isHumanAuthoredChat(ctx)) {
      throw new ExpectedToolError(
        "brain_retire_note_denied",
        "Brain notes can only be retired during a live chat session with a human operator.",
      );
    }

    const { retired, titles } = await retireNotesByDescription(ctx.tenant_id, args.description, {
      agent_slug: ctx.agent_slug ?? null,
    });
    return {
      retired,
      titles,
      message:
        retired > 0
          ? `Retired ${retired} note(s): ${titles.join("; ")}`
          : "No clearly-matching note was found to retire. Nothing was changed.",
    };
  },
};
