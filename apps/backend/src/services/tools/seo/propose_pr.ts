
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { checkSitePrProposal, type SitePrDeps } from "@/services/channels/site-pr";
import { typographicApostrophes } from "@/services/channels/page-copy-check";
import { MAX_COPY_BLOCKS, MAX_SEO_CHANGES, SEO_PR_SPEC, buildSeoPrCard, copyBlockSchema, seoChangeSchema, type SeoPrPayload } from "@/services/channels/seo-open-pr";
import { prCardEmitter, prCardResult } from "./file-pr-card";

const inputSchema = z.object({
  title: z.string().min(1).max(120).describe("One imperative action, e.g. \"Give /pricing its own title and description\"."),
  why: z.string().min(1).max(600).describe("Why it matters, in prose read in under a minute. Same bar as a step body."),
  page_url: z.string().url().max(500).describe("The ONE page these values belong to, on the company's own site, exactly as the audit returned it."),
  changes: z
    .array(seoChangeSchema)
    .min(1)
    .max(MAX_SEO_CHANGES)
    .optional()
    .describe(
      "Head-tag fixes for this page. kind: title | meta_description | h1 | robots | canonical. before: the value the audit read this run (\"\" when missing). after: the replacement, one line, paste-ready. Give changes OR copy, not both.",
    ),
  copy: z
    .array(copyBlockSchema)
    .min(1)
    .max(MAX_COPY_BLOCKS)
    .optional()
    .describe(
      "Page-copy fixes (body paragraphs or headings), up to 3 blocks of 600 characters, plain text only. current_text: the exact text on the page now, verbatim; new_text: its replacement. Give changes OR copy, not both.",
    ),
  evidence: z.array(z.string().min(1).max(300)).min(1).max(5).describe("What you read THIS run that shows the problem, with the URL."),
});

export type SeoProposePrInput = z.infer<typeof inputSchema>;

export function checkSeoPrProposal(
  tenantId: string,
  input: SeoProposePrInput,
  deps?: Pick<SitePrDeps, "engineerAllowed" | "website" | "resolveRepo">,
): Promise<SeoPrPayload> {
  if (!!input.changes === !!input.copy) {
    return Promise.reject(new ExpectedToolError("site_pr_invalid", "Give either head-tag changes or page copy, not both and not neither."));
  }
  const draft = input.copy
    ? ({ kind: "page_copy" as const, title: input.title, page_url: input.page_url, blocks: input.copy.map((b) => ({ current_text: b.current_text, new_text: typographicApostrophes(b.new_text) })) })
    : { title: input.title, page_url: input.page_url, changes: input.changes! };
  return checkSitePrProposal(SEO_PR_SPEC, tenantId, draft as Omit<SeoPrPayload, "repo">, deps);
}

export const seoProposePrTool: ToolSpec = {
  name: "seo_propose_pr",
  effect: "write",
  description:
    "File ONE page's tag fixes (title, meta description, H1, robots, canonical), or up to 3 plain-text page-copy blocks (exact current text and its replacement), as a card the founder can turn into a GitHub pull request with one press. Opens nothing until they press it, and Zavi never merges. Refuses when the workspace has no connected repo or is not on Pro; then file the fix as an ordinary step. A fix filed here is NOT also emitted as a step.",
  input_schema: inputSchema,
  async execute(ctx, rawInput) {
    const input = inputSchema.parse(rawInput);
    const pctx = ctx as unknown as { tenant_id: string };
    const payload = await checkSeoPrProposal(pctx.tenant_id, input);
    const card = buildSeoPrCard({ why: input.why, evidence: input.evidence, payload });
    const { emit, kept } = await prCardEmitter(ctx, SEO_PR_SPEC, payload, card);
    const action_id = await emit(SEO_PR_SPEC.execClass, { page_url: payload.page_url });
    return prCardResult(SEO_PR_SPEC, payload, action_id, kept());
  },
};
