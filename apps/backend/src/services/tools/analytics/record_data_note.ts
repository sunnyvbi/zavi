
import { z } from "zod";
import { ExpectedToolError, type ToolContext, type ToolSpec } from "@/services/tools/types";
import { isHumanAuthoredChat } from "@/services/agents/untrusted-context";
import { CATALOG_METRIC_IDS } from "@/services/analytics/metric-registry";
import { DATA_NOTE_MAX_CHARS, isTenantOwnerOrAdmin, recordDataNote } from "@/services/analytics/data-notes";
import { saveVerifiedQuery } from "@/services/analytics/verified-queries";
import { MAX_SQL_READS } from "@/services/tools/operator-db/codeact-sql";

async function requireFounderChat(ctx: ToolContext, code: string): Promise<void> {
  if (!isHumanAuthoredChat(ctx)) {
    throw new ExpectedToolError(code, "This can only be saved from a live chat with the founder, from what they said.");
  }
  if (!(await isTenantOwnerOrAdmin(ctx.tenant_id, actingUser(ctx)))) {
    throw new ExpectedToolError(code, "Only a workspace owner or admin can save this. Ask them to tell Zavi in chat.");
  }
}

function actingUser(ctx: ToolContext): string | null {
  return ctx.actor?.actor_user_id ?? null;
}

export const recordDataNoteInputSchema = z
  .object({
    metric_id: z
      .enum(CATALOG_METRIC_IDS)
      .optional()
      .describe("The catalog metric the correction is about. Omit when it is about the business data as a whole."),
    note_text: z
      .string()
      .trim()
      .min(3)
      .max(DATA_NOTE_MAX_CHARS)
      .describe("The founder's correction as one plain sentence, e.g. 'Revenue excludes test orders (paid with a staff email).'"),
  })
  .strict();

export const recordDataNoteTool: ToolSpec = {
  name: "growth_record_data_note",
  effect: "write",
  description:
    "Save a founder's correction about how a number should be read, when they tell you a number is wrong or how to count it " +
    "(e.g. 'revenue excludes test orders'). From then on growth__get_metric shows it in that metric's receipt caveats. " +
    "Earlier answers are not changed: tell the founder the numbers you gave before did not use the note, and re-answer with it. " +
    "Only for what the founder said in this chat, never your own guess.",
  input_schema: recordDataNoteInputSchema,
  async execute(ctx, input) {
    await requireFounderChat(ctx, "data_note_denied");
    const args = recordDataNoteInputSchema.parse(input);
    const note = await recordDataNote(ctx.tenant_id, {
      metric_id: args.metric_id ?? null,
      note_text: args.note_text,
      created_by: actingUser(ctx),
    });
    return {
      saved: true,
      note_id: note.id,
      metric_id: note.metric_id,
      saved_at: note.created_at,
      message:
        "Saved. New get_metric receipts for this metric carry the note as a caveat. Answers given before " +
        `${note.created_at.slice(0, 10)} keep their old numbers; say so, and do not restate them as corrected.`,
    };
  },
};

export const saveVerifiedQueryInputSchema = z
  .object({
    question: z.string().trim().min(3).max(500).describe("The founder's question the query answered, in their words."),
    sql_reads: z
      .array(z.string().min(1).max(5000))
      .min(1)
      .max(MAX_SQL_READS)
      .describe("The exact sql_reads of the operator_db codeact call whose answer the founder confirmed."),
  })
  .strict();

export const saveVerifiedQueryTool: ToolSpec = {
  name: "growth_save_verified_query",
  effect: "write",
  description:
    "Save the SQL behind an exploratory operator_db codeact answer after the founder confirms that answer was right. " +
    "Later codeact calls on a similar question get it back as a reference. Pass the exact sql_reads you ran and the question. " +
    "Read-only SQL only; the same checks run again every time it is used. Never save a query the founder did not confirm.",
  input_schema: saveVerifiedQueryInputSchema,
  async execute(ctx, input) {
    await requireFounderChat(ctx, "verified_query_denied");
    const args = saveVerifiedQueryInputSchema.parse(input);
    const saved = await saveVerifiedQuery(ctx.tenant_id, {
      question: args.question,
      sql_reads: args.sql_reads,
      created_by: actingUser(ctx),
    });
    return { saved: true, verified_query_id: saved.id };
  },
};
