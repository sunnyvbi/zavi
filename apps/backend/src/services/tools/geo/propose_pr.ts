
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { checkSitePrProposal, type SitePrDeps } from "@/services/channels/site-pr";
import { GEO_CHANGE_KINDS, GEO_PR_SPEC, buildGeoPrCard, geoChangeSchema, type GeoPrPayload } from "@/services/channels/geo-open-pr";
import { prCardEmitter, prCardResult } from "../seo/file-pr-card";

const inputSchema = z.object({
  title: z.string().min(1).max(120).describe("One imperative action, e.g. \"Let ChatGPT and Perplexity search crawl the site\"."),
  why: z.string().min(1).max(600).describe("Why it matters, in prose read in under a minute. Same bar as a step body."),
  page_url: z
    .string()
    .url()
    .max(500)
    .optional()
    .describe("The ONE page the json_ld and answer_block belong to, on the company's own site. Omit for a robots-only card."),
  changes: z
    .array(geoChangeSchema)
    .min(1)
    .max(GEO_CHANGE_KINDS.length)
    .describe(
      "At most one of each. robots_crawlers: AI crawler names to allow and/or block (offer the founder the search-rail vs training-rail split). json_ld: the full JSON-LD object for page_url, with \"@context\": \"https://schema.org\". answer_block: the 40-60 word answer for page_url's first screen, plain text, one paragraph; `replaces` = the passage it replaces, verbatim, or \"\". currently: what this run read today.",
    ),
  evidence: z.array(z.string().min(1).max(300)).min(1).max(5).describe("What you read THIS run that shows the problem, with the URL."),
});

export type GeoProposePrInput = z.infer<typeof inputSchema>;

export function checkGeoPrProposal(
  tenantId: string,
  input: GeoProposePrInput,
  deps?: Pick<SitePrDeps, "engineerAllowed" | "website" | "resolveRepo">,
): Promise<GeoPrPayload> {
  return checkSitePrProposal(
    GEO_PR_SPEC,
    tenantId,
    { title: input.title, ...(input.page_url ? { page_url: input.page_url } : {}), changes: input.changes },
    deps,
  );
}

export const geoProposePrTool: ToolSpec = {
  name: "geo_propose_pr",
  effect: "write",
  description:
    "File GEO fixes that live in the site's code (AI crawler rules in robots.txt, one page's JSON-LD, one page's answer block) as a card the founder can turn into a GitHub pull request with one press. Opens nothing until they press it, and Zavi never merges. Refuses when the workspace has no connected repo or is not on Pro; then file the fix as an ordinary step. A fix filed here is NOT also emitted as a step.",
  input_schema: inputSchema,
  async execute(ctx, rawInput) {
    const input = inputSchema.parse(rawInput);
    const pctx = ctx as unknown as { tenant_id: string };
    const payload = await checkGeoPrProposal(pctx.tenant_id, input);
    const card = buildGeoPrCard({ why: input.why, evidence: input.evidence, payload });
    const { emit, kept } = await prCardEmitter(ctx, GEO_PR_SPEC, payload, card);
    const action_id = await emit(GEO_PR_SPEC.execClass, {});
    return prCardResult(GEO_PR_SPEC, payload, action_id, kept());
  },
};
