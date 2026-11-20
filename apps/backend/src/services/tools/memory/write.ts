
import { z } from "zod";
import { serviceClient } from "@/services/supabase";
import { redactTrajectory } from "../../memory/redact-trajectory";
import { resolveCustomWriteRun } from "@/services/agents/custom-agent-writes";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { insertProposal } from "@/services/memory/write-path";
import { ExpectedToolError } from "../types";
import type { ToolSpec } from "../types";

const inputSchema = z.object({
  title: z.string().max(200).default("").describe("Short human-readable title for the note. Optional."),
  body_markdown: z.string().min(1).max(50_000).describe("Full markdown body. This is what gets chunked, embedded, and indexed."),
  tags: z.array(z.string().max(40)).max(10).default([]).describe("Optional tags. Used for filtering in the operator UI."),
});

const RAW_PASTE_THRESHOLD_BYTES = 5_000;

function looksLikeRawPaste(body: string): boolean {
  if (body.length <= RAW_PASTE_THRESHOLD_BYTES) return false;
  const hasHeading = /(^|\n)#{1,6}\s/.test(body);
  const hasList = /(^|\n)\s*(?:[-*+]|\d+\.)\s/.test(body);
  const hasEmphasis = /[*_`]/.test(body);
  const hasFence = /```/.test(body);
  return !(hasHeading || hasList || hasEmphasis || hasFence);
}

export const memoryWriteTool: ToolSpec = {
  name: "memory_write",
  effect: "write",
  description:
    "Ask to save a new fact / observation / decision to the tenant's memory. This does NOT save it now: after this run, the memory reviewer checks it against what is already saved (duplicate, newer value of a saved fact, or not durable) and saves it only if it passes. Use this AFTER answering when the run produced durable knowledge worth carrying forward (a customer fact, a policy clarification, a retrospective). Do NOT use to record routine output. Returns {queued: true, proposal_id, note}. Do not tell the user it is saved.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);

    if (looksLikeRawPaste(args.body_markdown)) {
      throw new ExpectedToolError(
        "memory_write_raw_paste_rejected",
        `body_markdown is ${args.body_markdown.length} bytes with no markdown structure (no headings, list items, emphasis, or code fences). This looks like a raw paste — break it into a structured note (## heading + bullet list + 1-paragraph summary) and retry. The brain indexes structured notes far better than wall-of-text.`,
      );
    }

    if (!ctx.run_id) {
      throw new ExpectedToolError(
        "memory_write_no_run",
        "memory_write only works inside an agent run; nothing was saved.",
      );
    }

    const redacted = redactTrajectory(args.body_markdown).value;
    const body_markdown =
      typeof redacted === "string" ? redacted : args.body_markdown;

    let thread_id: string | null = null;
    try {
      const { data } = await serviceClient()
        .from("agent_runs")
        .select("payload")
        .eq("id", ctx.run_id)
        .maybeSingle();
      const payload = data?.payload;
      if (payload && typeof payload === "object") {
        const tid = (payload as { thread_id?: unknown }).thread_id;
        if (typeof tid === "string") thread_id = tid;
      }
    } catch {
    }

    const { proposal_id } = await insertProposal(ctx.tenant_id, {
      run_id: ctx.run_id,
      thread_id,
      title: args.title,
      body: body_markdown,
      tags: args.tags,
    });
    return {
      queued: true,
      proposal_id,
      note: "Queued for memory review; not saved yet.",
    };
  },
};

export async function stampCustomAgentProvenance(
  tenant_id: string,
  run_id: string,
  agent_slug: string,
  note_id: string,
): Promise<boolean> {
  try {
    const run = await resolveCustomWriteRun(tenant_id, run_id, agent_slug);
    if (run.state !== "admitted" || run.tenant_id !== tenant_id) return false;
    const { error } = await tenantClient(asTenantId(run.tenant_id))
      .from("memory_note")
      .update({ custom_agent_id: run.agent_id, run_id: run.run_id })
      .eq("id", note_id)
      .eq("source_ref", run.run_id)
      .is("custom_agent_id", null);
    if (error) {
      console.warn(`[memory_write] custom agent provenance not saved: ${error.message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[memory_write] custom agent provenance threw: ${(e as Error).message}`);
    return false;
  }
}

export const __testHelpers = {
  looksLikeRawPaste,
  RAW_PASTE_THRESHOLD_BYTES,
};
