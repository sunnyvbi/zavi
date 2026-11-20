
import type { ToolSpec, ToolContext } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { z } from "zod";
import {
  HTML_PREVIEW_MAX_CHARS,
  type HtmlPreview,
} from "@/agents/engineer/output-schema";
import { RENDERED_MARKDOWN_MAX_CHARS } from "@/services/agents/engineer-caps";
import { publishWireframeLink } from "@/services/agents/prototype-links";
import { trackPrototypePublished } from "@/services/analytics/action-events";

export const renderWireframeInputSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(RENDERED_MARKDOWN_MAX_CHARS),
  html: z.string().min(1).max(HTML_PREVIEW_MAX_CHARS),
  notes: z
    .array(
      z.object({
        change: z.string().max(200),
        why: z.string().max(500),
      }),
    )
    .max(12)
    .optional(),
});

export type RenderWireframeInput = z.infer<typeof renderWireframeInputSchema>;

export type RenderWireframeResult = {
  published: true;
  url: string;
  slug: string;
};

const DESCRIPTION = [
  "Generate a DEEP, clickable HTML wireframe of a UI/flow and publish it as a",
  "shareable link the customer can open and click through. Use this when the",
  "operator wants to SEE and FEEL a proposed screen/flow before anything is built",
  "— an interactive prototype, not a static picture. (For a static ASCII/PDF",
  "mock use render_pdf instead; for a real running app the engineer builds it.)",
  "",
  "You write the `html` yourself — ONE self-contained HTML document:",
  "  - Inline everything: a single <style> block and a single vanilla-JS <script>",
  "    block. Load NO external resources — no CDN scripts, no web fonts, no remote",
  "    images, no fetch/XHR. Use system fonts, inline SVG, and data: URIs only.",
  "  - Make it REAL to click: wire every button/tab/toggle to a small JS state",
  "    machine that re-renders the view. No dead buttons — every interactive",
  "    element does something visible. This is the whole point of a wireframe.",
  "  - Keep it under ~200KB total (hard cap). A focused 40-80KB file is plenty.",
  "",
  "COLOUR — call report__get_page_design_guide FIRST; it carries this customer's own",
  "brand hexes (or says plainly that we could not read them, and names the neutral",
  "palette to use instead). Never invent a brand colour for a wireframe: an off-brand",
  "mock is worse than a grey one, because the operator cannot tell what is real.",
  "",
  "DATA — use SIMULATED data ONLY. Ground the STRUCTURE and brand feel in what you",
  "know about this customer's product (their entities, their layout, their tone),",
  "but every VALUE shown must be INVENTED placeholder data — realistic-looking",
  "fake names, numbers, and rows. NEVER put a real customer name, email, address,",
  "phone, order, balance, API key, or any real record on the wireframe. The page",
  "is publicly reachable by link, so real data would be a leak. (A secret pattern",
  "in the html blocks the publish outright.)",
  "",
  "Fields:",
  "  - title (≤120): shown as the wireframe's heading.",
  "  - summary (short): one or two sentences describing what the flow shows.",
  "  - html: the self-contained clickable document (see rules above).",
  "  - notes (optional, ≤12): { change, why } cards rendered beside the wireframe",
  "    to explain the key design decisions.",
  "",
  "DELIVERY: on success this returns { url, slug }. Put the `url` in your reply so",
  "the operator can open + click the prototype (it opens in their browser). Do NOT",
  "claim you opened a PR, deployed, or changed the live app — a wireframe is a",
  "design prototype only, with simulated data. If this returns an error, do NOT",
  "claim a link exists — say the wireframe couldn't be published and why.",
  "",
  "Errors: missing_run_ctx (no active run), invalid_input, wireframe_disabled",
  "(feature off for this tenant), leak_blocked (a secret pattern was found in the",
  "html — remove it), publish_failed.",
].join("\n");

export const renderWireframeTool: ToolSpec<RenderWireframeInput, RenderWireframeResult> = {
  name: "report_render_wireframe",
  effect: "write",
  description: DESCRIPTION,
  input_schema: renderWireframeInputSchema,
  async execute(ctx: ToolContext, input: RenderWireframeInput) {
    if (!ctx.run_id) {
      throw new ExpectedToolError(
        "missing_run_ctx",
        "report.render_wireframe requires an active run_id in context.",
      );
    }

    const envelope: HtmlPreview = {
      kind: "html_preview",
      variant: "wireframe",
      title: input.title,
      summary: input.summary,
      html: input.html,
      ...(input.notes && input.notes.length > 0 ? { rationale: input.notes } : {}),
    };

    const result = await publishWireframeLink({
      tenant_id: ctx.tenant_id,
      run_id: ctx.run_id,
      envelope,
    });

    if (result.published) {
      trackPrototypePublished({ tenant_id: ctx.tenant_id, prototype: "wireframe" });
      return { published: true, url: result.url, slug: result.slug };
    }

    if (result.reason === "disabled") {
      throw new ExpectedToolError(
        "wireframe_disabled",
        "The wireframe feature is turned off for this tenant.",
      );
    }
    if (result.reason === "blocked") {
      throw new ExpectedToolError(
        "leak_blocked",
        `The wireframe html contained a secret-like pattern (${result.detail ?? "redacted"}) and was not published. Remove any real keys/tokens/credentials and use simulated data only.`,
      );
    }
    throw new ExpectedToolError(
      "publish_failed",
      `The wireframe could not be published${result.detail ? `: ${result.detail}` : "."}`,
    );
  },
};
