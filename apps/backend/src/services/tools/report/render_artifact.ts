
import type { ToolSpec, ToolContext } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { z } from "zod";
import { createSharedPage, SHARED_PAGE_MAX_CHARS } from "@/services/shared-pages/page";
import { webBaseUrl } from "@/services/web-base";

export const renderArtifactInputSchema = z.object({
  title: z.string().min(1).max(120),
  html: z.string().min(1).max(SHARED_PAGE_MAX_CHARS),
});

export type RenderArtifactInput = z.infer<typeof renderArtifactInputSchema>;

export type RenderArtifactResult = {
  page_id: string;
  title: string;
  view_url: string;
  visibility: "private";
  handoff: string;
};

const DESCRIPTION = [
  "Build a designed, self-contained HTML page from this tenant's REAL data and save",
  "it to their workspace: a report, dashboard, explainer, plan, calculator or",
  "one-pager they can open, read, and choose to share. Use it when the ask is for",
  "something to look at or pass on, not a chat answer, and the right shape is a page",
  "rather than a PDF (render_pdf), slides (render_deck) or a spreadsheet.",
  "",
  "Call report__get_page_design_guide FIRST, once per run, and follow it. It lists",
  "the hard limits the page runs under (which libraries and fonts load; no network",
  "calls; inline images only; 200KB).",
  "",
  "Fields: title (<=120, names the page), html (the whole document).",
  "",
  "Every figure must come from something you read this run. Never invent a number.",
  "",
  "The page is PRIVATE: only signed-in members of this workspace can open view_url.",
  "Any member can make it public from the page itself; you cannot. Hand over",
  "view_url with the `handoff` sentence. Never call the page public, never invent",
  "a link. On an error, say the page was not saved and why.",
  "",
  "Errors: missing_run_ctx, invalid_input, too_large, leak_blocked (a key or",
  "token was in the html: remove it), save_failed.",
].join("\n");

export const renderArtifactTool: ToolSpec<RenderArtifactInput, RenderArtifactResult> = {
  name: "report_render_artifact",
  effect: "write",
  description: DESCRIPTION,
  input_schema: renderArtifactInputSchema,
  async execute(ctx: ToolContext, input: RenderArtifactInput) {
    if (!ctx.run_id) {
      throw new ExpectedToolError(
        "missing_run_ctx",
        "report.render_artifact requires an active run_id in context.",
      );
    }
    const row = await createSharedPage({
      tenant_id: ctx.tenant_id,
      run_id: ctx.run_id,
      title: input.title,
      html: input.html,
    });
    return {
      page_id: row.id,
      title: row.title,
      view_url: `${webBaseUrl()}/pages/${row.id}`,
      visibility: "private",
      handoff:
        "Only people in your workspace can open this link. To share it outside, open the page and click Make public.",
    };
  },
};
