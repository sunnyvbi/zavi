
import { z } from "zod";
import { searchMemory } from "@/services/memory";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  query: z.string().min(1).max(2000).describe("Natural-language query. Used for both keyword and embedding search."),
  k: z.number().int().min(1).max(50).default(8).describe("Max number of chunks to return."),
});

export const memorySearchTool: ToolSpec = {
  name: "memory_search",
  effect: "read",
  description:
    "Search the tenant's growable memory corpus (notes the operator authored + facts agents distilled from prior runs). Returns ranked chunks via hybrid keyword + vector RRF. READ TOOL — call freely before answering to ground responses in prior context. Each hit has {chunk_id, note_id, title, body, score, thread_id?}. thread_id is the owning chat thread when the note was distilled from a chat run; null for human notes, slack/email distills, and cron/manual runs. The workspace UI uses thread_id to render a cross-thread Brain tag when a hit comes from a different thread than the current one.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);
    const hits = await searchMemory(ctx.tenant_id, args.query, args.k, {
      run_id: ctx.run_id ?? null,
      agent_slug: ctx.agent_slug ?? null,
    });
    return { hits };
  },
};
