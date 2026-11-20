
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { fbGet } from "./_client";

const inputSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(100)
    .describe("The interest name to look up, e.g. \"Yoga\" or \"Home improvement\"."),
  limit: z.number().int().min(1).max(25).optional().default(10),
});

type InterestRow = {
  id?: string;
  name?: string;
  audience_size_lower_bound?: number;
  audience_size_upper_bound?: number;
  path?: string[];
  topic?: string;
};

export const metaSearchInterestsTool: ToolSpec = {
  name: "meta_ads_search_interests",
  effect: "read",
  description:
    "Look up REAL Meta interest targeting ids by name. Call this BEFORE proposing an ad set with interest targeting — the create path REJECTS interests that have no numeric id, because Meta rejects name-only interests. Returns candidates with id, name, audience size, and category path so you can pick the right one. NEVER guess or invent an interest id: a wrong id spends real money on the wrong audience. If nothing plausible comes back, say so and propose geo/demographic targeting instead of inventing an interest. Returns meta_ads_not_connected when Meta is absent.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { query, limit } = inputSchema.parse(input);

    const resp = (await fbGet(ctx.tenant_id, "search", {
      type: "adinterest",
      q: query,
      limit,
    })) as { data?: InterestRow[] };

    const rows = resp.data ?? [];
    const results = rows
      .filter((r): r is InterestRow & { id: string } => typeof r.id === "string" && r.id.length > 0)
      .map((r) => ({
        id: r.id,
        name: r.name ?? "(unnamed)",
        audience_size_lower_bound: r.audience_size_lower_bound ?? null,
        audience_size_upper_bound: r.audience_size_upper_bound ?? null,
        path: r.path ?? [],
        topic: r.topic ?? null,
      }));

    if (results.length === 0) {
      return {
        query,
        results_found: 0,
        results: [],
        message: `Meta returned no interest matching "${query}". Do NOT invent an id or substitute a different interest without saying so — propose geo/demographic targeting instead, or ask the operator which interest they meant.`,
      };
    }

    return {
      query,
      results_found: results.length,
      results,
      message: `Pass the chosen id into targeting as {id:"<id>", name:"<name>"}. Pick by audience size + category path; if several are plausible, say which you chose and why rather than guessing silently.`,
    };
  },
};
