
import { z } from "zod";
import { CHART_VARIANTS, ChartBlockSchema, htmlRendersBlank, HtmlBlockSchema, KpiBlockSchema, PostsBlockSchema, TableBlockSchema } from "@zavi/shared";

export { htmlRendersBlank };

export const UI_TOOL_NAMES = ["open_tab", "open_agent", "open_approval"] as const;
export type UiToolName = (typeof UI_TOOL_NAMES)[number];

export const UI_TOOL_HALT_MESSAGE =
  "Done — the browser is carrying out that action for the user right now. " +
  "Do NOT call this tool again and do NOT describe the action in prose. " +
  "End your turn with at most one short line.";

const JSON_SCHEMA_MAX_BYTES = 2048;

export const UiToolDeclSchema = z
  .object({
    name: z.enum(UI_TOOL_NAMES),
    description: z.string().min(1).max(200),
    parameters: z
      .record(z.string(), z.unknown())
      .refine((p) => Object.keys(p).length > 0, "parameters must be a non-empty JSON Schema")
      .refine((p) => JSON.stringify(p).length <= JSON_SCHEMA_MAX_BYTES, "parameters too large"),
  })
  .strict();

export type UiToolDecl = z.infer<typeof UiToolDeclSchema>;

export const UiToolsSchema = z.array(UiToolDeclSchema).max(8);

export function readUiTools(payload: unknown): UiToolDecl[] {
  const raw = (payload as { ui_tools?: unknown } | null)?.ui_tools;
  const r = UiToolsSchema.safeParse(raw);
  return r.success ? r.data : [];
}

const resultRef = z.string().regex(/^[mc]_[0-9a-f]{10}$/, "a result_id from growth__get_metric or growth__compute");
export const ChartInputSchema = ChartBlockSchema.omit({
  kind: true,
  verified: true,
  receipt: true,
  as_of: true,
  window: true,
  result_id: true,
  compare: true,
}).extend({
  series: ChartBlockSchema.shape.series.optional(),
  result_id: resultRef.optional(),
  compare_result_id: resultRef.optional(),
});

const kpiItemInput = z
  .object({
    label: z.string().min(1).max(80),
    value: z.union([z.string().max(40), z.number().finite()]).optional(),
    delta: z.string().max(60).optional(),
    tone: z.enum(["up", "down", "flat"]).optional(),
    result_id: resultRef.optional(),
  })
  .strict();

export const KpiInputSchema = z
  .object({
    title: KpiBlockSchema.shape.title,
    items: z.array(kpiItemInput).min(1).max(8),
  })
  .strict();

export const SHOW_TOOLS = {
  show_chart: {
    description:
      `Show the user a chart card in the chat. variant: ${CHART_VARIANTS.join(" | ")} (one series, up to 30 points). ` +
      "pie/donut = share of a whole; funnel = stage drop-off; area/line = trend; bar = comparison. " +
      "Use it instead of listing numbers in prose. " +
      "For a business metric pass `result_id` from growth__get_metric (and `compare_result_id` for the prior period) instead of `series`: the server draws the real values with their source. " +
      "COLOURS: any request about a chart's appearance — \"make negative red and positive green\", " +
      "\"use blue\", \"colour by sign\" — is THIS tool with `colors`, never show_html. " +
      "`colors` takes {series} for one hue, or {positive, negative} to colour by sign. " +
      "Each value MUST be a hex literal like \"#16a34a\" or \"#0f0\"; anything else is rejected. " +
      "To recolour, call show_chart again with the SAME title and the SAME series and the new colors — " +
      "never alter the numbers to satisfy a colour request, and never redraw the chart as HTML to get a colour. " +
      "`colors` applies to bar/line/area; pie, donut and funnel keep one distinct hue per slice.",
    schema: ChartInputSchema,
    kind: "chart" as const,
  },
  show_kpis: {
    description:
      "Show the user up to 8 headline numbers as KPI cards (label, value, optional delta like \"+12% vs last week\" with tone up/down/flat). Use for a campaign or period summary. " +
      "For a business metric give the item a `result_id` from growth__get_metric or growth__compute instead of `value`: the server fills in the value, delta and source.",
    schema: KpiInputSchema,
    kind: "kpi" as const,
  },
  show_table: {
    description:
      "Show the user a compact table card in the chat (≤8 columns, ≤50 rows). Use when the answer is naturally rows and columns, and always instead of a markdown table.",
    schema: TableBlockSchema.omit({ kind: true }),
    kind: "table" as const,
  },
  show_posts: {
    description:
      "Show the user platform-accurate previews of social post drafts (channel + payload as in social__propose_post). Does NOT propose or publish anything.",
    schema: PostsBlockSchema.omit({ kind: true }),
    kind: "posts" as const,
  },
  show_html: {
    description:
      "NOT FOR CHARTS. A bar/line/area/pie/donut/funnel chart is show_chart, including every restyle of one — " +
      "\"make negatives red\", \"use green\", \"colour by sign\" is show_chart with `colors`, never this tool. " +
      "A chart drawn here loses the workspace theme (it renders white in dark mode) and repeats its own title inside the card. " +
      "Use this ONLY for a visual the other cards genuinely cannot express: " +
      "a self-contained HTML document with inline CSS and inline SVG (diagrams, timelines, comparison layouts, mini dashboards, annotated funnels). " +
      "Frames, forms and every external resource (fonts, images by URL, stylesheets, CDN scripts) are stripped and blocked — draw with SVG and CSS, use data: URIs for images. " +
      "DRAW EVERYTHING DECLARATIVELY. Inline <script> and on* handlers may be allowed (no network: no fetch, no navigation, no window.open — the document is rejected if it tries), but many workspaces have scripts OFF, and there they are stripped. " +
      "So a script must only ever ENHANCE (hover read-outs, a toggle, animation) — never draw. An empty <svg> or a <canvas> that a script was going to fill is REJECTED, because with scripts off it renders as a blank box. Put the shapes in the markup. " +
      "Keep it under 200KB, readable at 640px wide, no fixed heights taller than ~700px. Prefer show_chart/show_kpis/show_table when they fit; use this for everything else.",
    schema: HtmlBlockSchema.omit({ kind: true, scripts: true }),
    kind: "html" as const,
  },
} as const;

export type ShowToolName = keyof typeof SHOW_TOOLS;

