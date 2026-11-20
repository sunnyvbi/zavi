
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import {
  deliverBlogHtml,
  deliverBlogHtmlInputSchema,
  type DeliverBlogHtmlInput,
  type DeliverBlogHtmlResult,
} from "@/services/reports/deliver-html";

const DESCRIPTION = [
  "Render a blog post to a self-contained HTML file and return a downloadable",
  "artifact. Use ONLY when the operator explicitly asks you to WRITE A BLOG /",
  "blog post / article they can read or download. This delivers a DRAFT for the",
  "operator to review — it does NOT publish anything to their live site.",
  "",
  "Input fields:",
  "  - title (string, ≤300): the blog headline. Keep it short and clear.",
  "  - subtitle (string, ≤500, optional): one-line summary under the title.",
  "  - body (string): the blog body as MARKDOWN. Supported: `#`/`##`/`###`",
  "    headings, **bold**, `inline code`, [text](url) links, `- ` / `1. ` lists,",
  "    `> ` quotes, `---` rules, GFM pipe tables (| a | b | over |---|---|), and",
  "    ``` fenced code blocks (put the language after the opening fence, e.g.",
  "    ```json — a JSON-LD block belongs in one). Blank-line paragraphs.",
  "    Write benefit-led, skimmable copy with a single clear CTA.",
  "    Every fact/number must be verified — never invent stats (honesty rule).",
  "  - readTimeMinutes (int, optional): shown in the byline.",
  "  - image_concepts (array of ≤3 strings, optional): one prompt per hero image.",
  "    Each is generated as a 16:9 image and embedded at the top as a gallery.",
  "    Keep prompts conceptual/lifestyle (AI cannot render real UI/screens or",
  "    readable text). Omit for a text-only blog. Image generation is best-effort:",
  "    if it is unavailable the blog is still delivered without images.",
  "  - filename (string, ≤120): output filename; `.html` is forced if missing.",
  "  - channel_id + thread_ts (string, optional): if set, the file is ALSO",
  "    dropped into that Slack thread (soft-fail if Slack errors).",
  "",
  "Returns: { artifact_id, filename, bytes, slack_ok, images_generated }.",
  "",
  "DELIVERY: on success the platform AUTOMATICALLY attaches the rendered file as",
  "a clickable chip directly UNDER your chat message (the operator clicks it to",
  "download / open the blog). That chip IS the delivery. Refer to the file by",
  "`filename` and say it's attached below — do NOT redirect the operator",
  "elsewhere to fetch it. Delivered files are also kept in the workspace Artifacts",
  "page, which you may mention only if they ask where past files live. Never",
  "point at a 'Files' page or the website — neither carries this file. If",
  "this call returns an error, do NOT claim a blog exists — report the failure.",
  "Errors: invalid_input, missing_run_ctx, run_lookup_failed, tenant_mismatch,",
  "blog_render_failed, blog_too_large, storage_upload_failed, artifact_row_failed.",
].join("\n");

export const renderBlogTool: ToolSpec<DeliverBlogHtmlInput, DeliverBlogHtmlResult> = {
  name: "report_render_blog",
  effect: "write",
  description: DESCRIPTION,
  input_schema: deliverBlogHtmlInputSchema,
  async execute(ctx, input) {
    if (!ctx.run_id) {
      throw new ExpectedToolError(
        "missing_run_ctx",
        "report.render_blog requires an active run_id in context.",
      );
    }
    return deliverBlogHtml(
      {
        tenant_id: ctx.tenant_id,
        run_id: ctx.run_id,
        slack_team_id: ctx.slack_team_id,
        log: ctx.log,
      },
      input,
    );
  },
};
