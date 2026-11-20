import { z } from "zod";
import {
  MAX_TABLE_ROWS,
  TOTAL_PROSE_BUDGET,
  renderPdfInputSchema,
  logoSpecSchema,
} from "./schema";

const MAX_TITLE = 200;
const MAX_HEADING = 200;
const MAX_BODY = 10_000;
const MAX_PREFORMATTED = 12_000;
const MAX_SECTIONS = 20;
const MAX_TABLE_COLS = 8;
const MAX_CELL = 500;
const MAX_FOOTER = 500;
const MAX_FILENAME = 120;
const MAX_IMAGE_CONCEPT = 1_000;
const BODY_BUDGET = TOTAL_PROSE_BUDGET - 4_000;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

type CoercedTable = { columns: string[]; rows: string[][] };
function coerceTable(t: unknown): CoercedTable | undefined {
  if (!t || typeof t !== "object") return undefined;
  const raw = t as { columns?: unknown; rows?: unknown };
  const cols = Array.isArray(raw.columns)
    ? raw.columns.filter((c): c is string => typeof c === "string").slice(0, MAX_TABLE_COLS).map((c) => clip(c, MAX_CELL))
    : [];
  if (cols.length === 0) return undefined;
  const rowsRaw = Array.isArray(raw.rows) ? raw.rows.slice(0, MAX_TABLE_ROWS) : [];
  const rows = rowsRaw.map((r) => {
    const cellsRaw = Array.isArray(r)
      ? r
      : r && typeof r === "object"
        ? (() => {
            const o = r as { cells?: unknown; values?: unknown };
            if (Array.isArray(o.cells)) return o.cells;
            if (Array.isArray(o.values)) return o.values;
            return Object.values(o as Record<string, unknown>);
          })()
        : [];
    const cells = cellsRaw.map((c) => clip(str(c), MAX_CELL));
    if (cells.length < cols.length) return [...cells, ...Array(cols.length - cells.length).fill("")];
    return cells.slice(0, cols.length);
  });
  return { columns: cols, rows };
}

type CoercedSection = {
  heading: string;
  body_markdown: string;
  preformatted?: string;
  table?: CoercedTable;
  image_concept?: string;
  logo_spec?: unknown;
};

export function coerceRenderPdfInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;

  if (typeof r.title !== "string" || !Array.isArray(r.sections) || r.sections.length === 0) {
    return raw;
  }

  const title = clip(str(r.title).trim() || "Report", MAX_TITLE);

  const rawSections = Array.isArray(r.sections) ? r.sections : [];
  const out: CoercedSection[] = [];
  let used = 0;
  let truncated = false;
  for (const s of rawSections) {
    if (out.length >= MAX_SECTIONS) {
      truncated = true;
      break;
    }
    if (!s || typeof s !== "object") continue;
    const sec = s as Record<string, unknown>;
    const heading = clip(str(sec.heading).trim() || `Section ${out.length + 1}`, MAX_HEADING);
    let table = coerceTable(sec.table);
    let body = clip(str(sec.body_markdown), MAX_BODY);
    const preformatted =
      typeof sec.preformatted === "string" && sec.preformatted.length > 0
        ? sec.preformatted.slice(0, MAX_PREFORMATTED)
        : undefined;
    if (!table && !preformatted && body.trim().length === 0) body = "—";

    const tableCost = table ? table.rows.flat().reduce((a, c) => a + c.length, 0) : 0;
    const preCost = preformatted?.length ?? 0;
    const remaining = BODY_BUDGET - used - heading.length - tableCost - preCost;
    if (remaining <= 0) {
      if (table || preformatted) {
        truncated = true;
        continue;
      }
      if (BODY_BUDGET - used - heading.length > 1) {
        body = "…";
        truncated = true;
      } else {
        truncated = true;
        continue;
      }
    } else if (body.length > remaining) {
      body = remaining > 1 ? `${body.slice(0, remaining - 1)}…` : "—";
      truncated = true;
    }
    const section: CoercedSection = { heading, body_markdown: body };
    if (preformatted) section.preformatted = preformatted;
    if (table) section.table = table;
    const declaredLogoSpec = !!sec.logo_spec && typeof sec.logo_spec === "object";
    if (declaredLogoSpec) {
      const parsed = logoSpecSchema.safeParse(sec.logo_spec);
      if (parsed.success) section.logo_spec = parsed.data;
    }
    if (!declaredLogoSpec && typeof sec.image_concept === "string") {
      const trimmed = sec.image_concept.trim();
      if (trimmed.length > 0) {
        section.image_concept = trimmed.length > MAX_IMAGE_CONCEPT
          ? trimmed.slice(0, MAX_IMAGE_CONCEPT)
          : trimmed;
      }
    }
    out.push(section);
    used += heading.length + body.length + tableCost + preCost;
  }
  if (out.length === 0) {
    out.push({ heading: "Summary", body_markdown: clip(str(r.subtitle).trim() || title, MAX_BODY) });
  }

  const filenameRaw = str(r.filename).trim();
  const titleSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const fallbackName = titleSlug ? `${titleSlug}.pdf` : "report.pdf";
  const filename = clip(filenameRaw || fallbackName, MAX_FILENAME);

  const coerced: Record<string, unknown> = { title, sections: out, filename };
  const baseFooter =
    typeof r.footer === "string" && r.footer.length > 0 ? r.footer : "";
  if (truncated) {
    const notice =
      "Note: this report was shortened to fit the size limit, so some content was left out.";
    const room = MAX_FOOTER - notice.length - 2;
    const head = baseFooter && room > 0 ? `${clip(baseFooter, room)}  ` : "";
    coerced.footer = `${head}${notice}`;
  } else if (baseFooter) {
    coerced.footer = clip(baseFooter, MAX_FOOTER);
  }
  if (typeof r.channel_id === "string") coerced.channel_id = r.channel_id;
  if (typeof r.thread_ts === "string") coerced.thread_ts = r.thread_ts;
  if (r.title_metadata && typeof r.title_metadata === "object" && !Array.isArray(r.title_metadata)) {
    const tm = r.title_metadata as Record<string, unknown>;
    const meta: Record<string, string> = {};
    if (typeof tm.author === "string") meta.author = clip(tm.author, 80);
    if (typeof tm.subject === "string") meta.subject = clip(tm.subject, 200);
    if (Object.keys(meta).length > 0) coerced.title_metadata = meta;
  }
  return coerced;
}

export const renderPdfInputSchemaCoerced = z.preprocess(
  coerceRenderPdfInput,
  renderPdfInputSchema,
);
