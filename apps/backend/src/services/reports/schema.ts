
import { z } from "zod";

const MAX_TITLE = 200;
const MAX_HEADING = 200;
const MAX_BODY = 10_000;
const MAX_PREFORMATTED = 12_000;
const MAX_SECTIONS = 20;
const MAX_TABLE_COLS = 8;
export const MAX_TABLE_ROWS = 30;
const MAX_CELL = 500;
const MAX_FOOTER = 500;
const MAX_FILENAME = 120;
export const TOTAL_PROSE_BUDGET = 50_000;
export const MAX_IMAGE_CONCEPT = 1_000;

export const MAX_LOGO_ELEMENTS = 40;
export const MAX_LOGO_SPEC_PER_CALL = 6;
const MAX_PATH_D = 2_000;
const MAX_POINTS = 2_000;
const MAX_TEXT_CONTENT = 40;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const NAMED_COLORS = new Set([
  "none", "transparent", "currentcolor", "white", "black", "red", "green",
  "blue", "navy", "gold", "silver", "gray", "grey", "orange", "purple",
  "teal", "maroon", "yellow", "cyan", "magenta", "pink", "brown", "beige",
  "ivory", "olive", "lime", "aqua", "fuchsia", "indigo", "coral", "salmon",
  "khaki", "crimson", "turquoise", "tan", "slategray", "slategrey",
]);
const logoColor = z
  .string()
  .max(32)
  .refine((c) => HEX_COLOR.test(c) || NAMED_COLORS.has(c.toLowerCase()), {
    message: "color must be a #hex value or a named-color allowlist member",
  });
const coord = z.number().finite().min(-10_000).max(10_000);
const length = z.number().finite().min(0).max(10_000);
const strokeW = z.number().finite().min(0).max(100).optional();
const PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\-+\s]+$/;
const POINTS = /^[0-9eE.,\-+\s]+$/;

const logoStroke = { fill: logoColor.optional(), stroke: logoColor.optional(), stroke_width: strokeW };

const logoElementSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("path"), d: z.string().min(1).max(MAX_PATH_D).regex(PATH_D, "path.d must match the SVG path-data grammar"), ...logoStroke }),
  z.object({ type: z.literal("rect"), x: coord, y: coord, width: length, height: length, rx: length.optional(), ry: length.optional(), ...logoStroke }),
  z.object({ type: z.literal("circle"), cx: coord, cy: coord, r: length, ...logoStroke }),
  z.object({ type: z.literal("ellipse"), cx: coord, cy: coord, rx: length, ry: length, ...logoStroke }),
  z.object({ type: z.literal("line"), x1: coord, y1: coord, x2: coord, y2: coord, stroke: logoColor.optional(), stroke_width: strokeW }),
  z.object({ type: z.literal("polygon"), points: z.string().min(1).max(MAX_POINTS).regex(POINTS, "points must be a numeric coordinate list"), ...logoStroke }),
  z.object({ type: z.literal("polyline"), points: z.string().min(1).max(MAX_POINTS).regex(POINTS, "points must be a numeric coordinate list"), ...logoStroke }),
  z.object({
    type: z.literal("text"),
    content: z.string().min(1).max(MAX_TEXT_CONTENT),
    x: coord,
    y: coord,
    font_family: z.enum(["sans", "serif", "mono"]),
    font_size: z.number().finite().min(1).max(512),
    font_weight: z.enum(["normal", "bold"]).optional(),
    fill: logoColor.optional(),
    text_anchor: z.enum(["start", "middle", "end"]).optional(),
  }),
]);
export type LogoElement = z.infer<typeof logoElementSchema>;

export const logoSpecSchema = z.object({
  viewBox: z
    .string()
    .regex(/^0 0 (?:[1-9]\d{0,2}|512) (?:[1-9]\d{0,2}|512)$/, "viewBox must be '0 0 W H' with W,H in 1..512")
    .optional(),
  background: logoColor.optional(),
  elements: z.array(logoElementSchema).min(1).max(MAX_LOGO_ELEMENTS),
});
export type LogoSpec = z.infer<typeof logoSpecSchema>;

export const renderPdfInputSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE),
    sections: z
      .array(
        z.object({
          heading: z.string().min(1).max(MAX_HEADING),
          body_markdown: z.string().max(MAX_BODY),
          preformatted: z.string().max(MAX_PREFORMATTED).optional(),
          image_concept: z.string().min(1).max(MAX_IMAGE_CONCEPT).optional(),
          logo_spec: logoSpecSchema.optional(),
          table: z
            .object({
              columns: z
                .array(z.string().max(MAX_CELL))
                .min(1)
                .max(MAX_TABLE_COLS),
              rows: z
                .array(
                  z.array(z.string().max(MAX_CELL)).min(1).max(MAX_TABLE_COLS),
                )
                .max(MAX_TABLE_ROWS),
            })
            .optional()
            .refine(
              (t) => !t || t.rows.every((r) => r.length === t.columns.length),
              { message: "every row must have exactly one cell per column" },
            ),
        }),
      )
      .min(1)
      .max(MAX_SECTIONS),
    footer: z.string().max(MAX_FOOTER).optional(),
    filename: z.string().min(1).max(MAX_FILENAME),
    channel_id: z.string().optional(),
    thread_ts: z.string().optional(),
    title_metadata: z
      .object({
        author: z.string().max(80).optional(),
        subject: z.string().max(200).optional(),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    const prose =
      v.title.length +
      (v.footer?.length ?? 0) +
      v.sections.reduce(
        (a, s) =>
          a +
          s.heading.length +
          s.body_markdown.length +
          (s.preformatted?.length ?? 0) +
          (s.table?.rows.flat().reduce((b, c) => b + c.length, 0) ?? 0),
        0,
      );
    if (prose > TOTAL_PROSE_BUDGET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `total prose ${prose} bytes exceeds ${TOTAL_PROSE_BUDGET} budget`,
      });
    }
    const logoCount = v.sections.filter((s) => s.logo_spec).length;
    if (logoCount > MAX_LOGO_SPEC_PER_CALL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `too many logo_spec sections in one call (${logoCount}); max is ${MAX_LOGO_SPEC_PER_CALL}. Deliver ~${MAX_LOGO_SPEC_PER_CALL} strong, distinct concepts in this PDF and offer the user more variations on request (a follow-up render_pdf call). A tight set of ${MAX_LOGO_SPEC_PER_CALL} is a better deliverable — and renders fast — than a giant set that times out.`,
      });
    }
  });

export type RenderPdfInput = z.infer<typeof renderPdfInputSchema>;

export const MAX_CSV_COLS = 50;
export const MAX_CSV_ROWS = 5_000;
const MAX_CSV_CELL = 2_000;
const CSV_TOTAL_BUDGET = 5_000_000;

export const renderCsvInputSchema = z
  .object({
    filename: z.string().min(1).max(MAX_FILENAME),
    columns: z.array(z.string().max(MAX_CSV_CELL)).min(1).max(MAX_CSV_COLS),
    rows: z
      .array(z.array(z.string().max(MAX_CSV_CELL)).max(MAX_CSV_COLS))
      .max(MAX_CSV_ROWS),
  })
  .refine((v) => v.rows.every((r) => r.length === v.columns.length), {
    message: "every row must have exactly one cell per column",
  })
  .superRefine((v, ctx) => {
    const total =
      v.columns.reduce((a, c) => a + c.length, 0) +
      v.rows.reduce((a, r) => a + r.reduce((b, c) => b + c.length, 0), 0);
    if (total > CSV_TOTAL_BUDGET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `total cell text ${total} bytes exceeds ${CSV_TOTAL_BUDGET} budget`,
      });
    }
  });

export type RenderCsvInput = z.infer<typeof renderCsvInputSchema>;

export const MAX_XLSX_SHEETS = 10;
export const MAX_XLSX_COLS = 50;
export const MAX_XLSX_ROWS = 5_000;
export const MAX_XLSX_TOTAL_CELLS = 20_000;
const MAX_XLSX_CELL = 2_000;
export const MAX_XLSX_SHEET_NAME = 31;
const XLSX_TOTAL_BUDGET = 5_000_000;
const INVALID_SHEET_NAME = /[:\\/?*[\]]/;

export const XLSX_COLUMN_TYPES = ["text", "number", "money", "percent", "date"] as const;
export type XlsxColumnType = (typeof XLSX_COLUMN_TYPES)[number];

const xlsxCell = z.union([z.string().max(MAX_XLSX_CELL), z.number(), z.boolean(), z.null()]);

export const renderXlsxInputSchema = z
  .object({
    filename: z.string().min(1).max(MAX_FILENAME),
    sheets: z
      .array(
        z.object({
          name: z.string().min(1).max(MAX_XLSX_SHEET_NAME),
          columns: z
            .array(
              z.object({
                header: z.string().max(MAX_XLSX_CELL),
                type: z.enum(XLSX_COLUMN_TYPES).default("text"),
                width: z.number().int().min(4).max(80).optional(),
              }),
            )
            .min(1)
            .max(MAX_XLSX_COLS),
          rows: z.array(z.array(xlsxCell).max(MAX_XLSX_COLS)).max(MAX_XLSX_ROWS),
        }),
      )
      .min(1)
      .max(MAX_XLSX_SHEETS),
  })
  .superRefine((v, ctx) => {
    const names = new Set<string>();
    let cells = 0;
    let text = 0;
    for (const s of v.sheets) {
      const key = s.name.trim().toLowerCase();
      if (names.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate sheet name "${s.name}" — Excel requires every tab to be uniquely named.`,
        });
      }
      names.add(key);
      if (INVALID_SHEET_NAME.test(s.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `sheet name "${s.name}" contains a character Excel forbids in a tab name (: \\ / ? * [ ]).`,
        });
      }
      for (let i = 0; i < s.rows.length; i++) {
        if (s.rows[i].length !== s.columns.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `sheet "${s.name}" row ${i + 1} has ${s.rows[i].length} cells but ` +
              `${s.columns.length} columns; every row must have exactly one cell per column.`,
          });
          break;
        }
      }
      cells += s.columns.length * (s.rows.length + 1);
      text += s.columns.reduce((a, c) => a + c.header.length, 0);
      for (const r of s.rows) {
        for (const c of r) if (typeof c === "string") text += c.length;
      }
    }
    if (cells > MAX_XLSX_TOTAL_CELLS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `${cells} cells across all sheets exceeds the ${MAX_XLSX_TOTAL_CELLS} limit for one call. ` +
          `Narrow the export to the columns and rows the customer actually asked about, or split ` +
          `it across follow-up calls — a focused sheet is a better deliverable than a dump, and a ` +
          `call this large risks being cut off while the request is still being written.`,
      });
    }
    if (text > XLSX_TOTAL_BUDGET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `total cell text ${text} bytes exceeds ${XLSX_TOTAL_BUDGET} budget`,
      });
    }
  });

export type RenderXlsxInput = z.infer<typeof renderXlsxInputSchema>;
