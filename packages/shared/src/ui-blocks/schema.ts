
import { z } from "zod";

export const UI_BLOCK_MIME = "application/vnd.zavi.ui+json";
export const HTML_BLOCK_MAX_CHARS = 200 * 1024;

const label = z.string().min(1).max(80);
const title = z.string().min(1).max(120);

export const CHART_VARIANTS = ["bar", "line", "area", "pie", "donut", "funnel"] as const;

const hexColor = z
  .string()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "colour must be a hex literal like #16a34a");

export const ChartColorsSchema = z
  .object({
    series: hexColor.optional(),
    positive: hexColor.optional(),
    negative: hexColor.optional(),
  })
  .strict();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const BlockWindowSchema = z.object({ since: isoDate, until: isoDate }).strict();

export const BlockReceiptSchema = z
  .object({
    source: z.string().min(1).max(40),
    metric_id: z.string().max(60).optional(),
    definition: z.string().max(300).optional(),
    fetched_at: z.string().max(40).optional(),
    window: BlockWindowSchema.optional(),
    tz: z.string().max(64).optional(),
    currency: z.string().max(8).nullable().optional(),
    formula: z.string().max(300).optional(),
    caveats: z.array(z.string().max(300)).max(8).optional(),
  })
  .strict();

const provenance = {
  result_id: z.string().max(40).optional(),
  verified: z.boolean().optional(),
  receipt: BlockReceiptSchema.optional(),
  as_of: z.string().max(40).optional(),
  window: BlockWindowSchema.optional(),
};

const chartPoint = z.object({ label, value: z.number().finite() });

export const ChartBlockSchema = z
  .object({
    kind: z.literal("chart"),
    title,
    variant: z.enum(CHART_VARIANTS).default("bar"),
    unit: z.string().max(8).optional(),
    series: z.array(chartPoint).min(1).max(30),
    colors: ChartColorsSchema.optional(),
    compare: z.array(chartPoint).max(30).optional(),
    goal: z.number().finite().optional(),
    ...provenance,
  })
  .strict();

export const KpiBlockSchema = z
  .object({
    kind: z.literal("kpi"),
    title,
    items: z
      .array(
        z.object({
          label,
          value: z.union([z.string().max(40), z.number().finite()]),
          delta: z.string().max(60).optional(),
          tone: z.enum(["up", "down", "flat"]).optional(),
          result_id: provenance.result_id,
          verified: provenance.verified,
          receipt: provenance.receipt,
        }),
      )
      .min(1)
      .max(8),
    verified: provenance.verified,
  })
  .strict();

export const TableBlockSchema = z
  .object({
    kind: z.literal("table"),
    title,
    columns: z.array(label).min(1).max(8),
    rows: z
      .array(z.array(z.union([z.string().max(200), z.number().finite(), z.null()])).max(8))
      .min(1)
      .max(50),
    note: z.string().max(300).optional(),
  })
  .strict();

export const PostsBlockSchema = z
  .object({
    kind: z.literal("posts"),
    title,
    posts: z
      .array(
        z.object({
          channel: z.string().min(1).max(40),
          payload: z.record(z.string(), z.unknown()),
          scheduled_at: z.string().nullable().optional(),
          label: z.string().max(80).optional(),
        }),
      )
      .min(1)
      .max(10),
  })
  .strict();

export const HtmlBlockSchema = z
  .object({
    kind: z.literal("html"),
    title,
    html: z.string().min(1).max(HTML_BLOCK_MAX_CHARS),
    height: z.number().int().min(120).max(1200).optional(),
    scripts: z.boolean().optional(),
  })
  .strict();

export function htmlRendersBlank(html: string): boolean {
  if (/<canvas\b/i.test(html)) return true;

  const normalized = html.replace(/<svg\b[^>]*\/>/gi, "<svg></svg>");
  const svgs = normalized.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/gi);
  if (!svgs || svgs.length === 0) return false;

  const childless = (svg: string) =>
    !/<[a-z]/i.test(svg.replace(/^<svg\b[^>]*>/i, "").replace(/<\/svg>$/i, ""));

  const RESERVED_PX = 120;
  const sized = (svg: string) => {
    const open = svg.match(/^<svg\b[^>]*>/i)?.[0] ?? "";
    const dim = (attr: string) => {
      const raw = open.match(new RegExp(`\\b${attr}\\s*=\\s*["']?([0-9.]+)`, "i"))?.[1];
      return raw ? Number(raw) : 0;
    };
    if (dim("width") >= RESERVED_PX || dim("height") >= RESERVED_PX) return true;
    return /\bviewBox\s*=/i.test(open) || /height\s*:\s*[0-9.]+(px|vh|%)/i.test(open);
  };

  return svgs.every(childless) && svgs.some(sized);
}

export const UiBlockSchema = z.discriminatedUnion("kind", [
  ChartBlockSchema,
  KpiBlockSchema,
  TableBlockSchema,
  PostsBlockSchema,
  HtmlBlockSchema,
]);

export type UiBlock = z.infer<typeof UiBlockSchema>;
export type UiBlockKind = UiBlock["kind"];
export type ChartBlock = z.infer<typeof ChartBlockSchema>;
export type KpiBlock = z.infer<typeof KpiBlockSchema>;
export type TableBlock = z.infer<typeof TableBlockSchema>;
export type PostsBlock = z.infer<typeof PostsBlockSchema>;
export type HtmlBlock = z.infer<typeof HtmlBlockSchema>;
export type BlockReceipt = z.infer<typeof BlockReceiptSchema>;

export function parseUiBlock(raw: unknown): UiBlock | null {
  const r = UiBlockSchema.safeParse(raw);
  return r.success ? r.data : null;
}
