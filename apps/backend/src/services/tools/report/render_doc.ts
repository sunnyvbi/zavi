
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import {
  deliverDoc,
  deliverDocInputSchema,
  type DeliverDocInput,
  type DeliverDocResult,
} from "@/services/reports/deliver-doc";

const DESCRIPTION = [
  "Render a structured EXPLAINER DOCUMENT to a styled, scrollable web page and return a shareable link plus a stored artifact.",
  "",
  "Use this — not render_pdf — when someone asks you to explain how something works FOR OTHER PEOPLE: 'explain X so the team understands', 'walk me through X end to end', 'write this up for support'. Use render_pdf when they asked for a PDF by name, and render_deck when they asked for slides.",
  "",
  "Input fields:",
  "  - title (string, ≤200): shown at the top and used for the filename.",
  "  - subtitle (string, ≤300, optional): one line saying what the document is for.",
  "  - eyebrow (string, ≤80, optional): small uppercase kicker, e.g. 'Checkout · Money path'.",
  "  - sections (array, 1-20): each { heading, body_markdown?, steps?, ledger?, callout?, table? }.",
  "",
  "The three blocks are what make an explainer readable — reach for them instead of more prose:",
  "  - steps: an ORDERED mechanism, [{title, body?, meta?}]. meta is a code anchor or timing note in monospace.",
  "  - ledger: a worked example with real numbers, [{label, value, note?, emphasis?}]. Values are pre-formatted; the renderer does no maths. emphasis 'total' bolds a row, 'positive'/'negative' colour it.",
  "  - callout: {tone: info|warn|success, body} — the one thing the reader must not miss.",
  "",
  "You supply STRUCTURE, never markup: every string is escaped and the renderer owns the styling, so all documents look alike and nothing you write can become HTML.",
  "",
  "The returned `url` is a PUBLIC page that needs no sign-in. When you hand it over you MUST pass on `link_disclosure` verbatim. If `url` is null with link_error 'disabled', the tenant has public links off — that is a normal success, so deliver the attached file and say nothing about a link.",
].join("\n");

export const renderDocTool: ToolSpec<DeliverDocInput, DeliverDocResult> = {
  name: "report_render_doc",
  effect: "write",
  description: DESCRIPTION,
  input_schema: deliverDocInputSchema,
  async execute(ctx, input) {
    if (!ctx.run_id) {
      throw new ExpectedToolError(
        "missing_run_ctx",
        "report.render_doc requires an active run_id in context.",
      );
    }
    return deliverDoc(
      { tenant_id: ctx.tenant_id, run_id: ctx.run_id, log: ctx.log },
      input,
    );
  },
};
