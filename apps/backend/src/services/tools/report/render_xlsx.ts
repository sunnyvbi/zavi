
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { renderXlsxInputSchema, type RenderXlsxInput } from "@/services/reports/schema";
import { deliverXlsx, type DeliverXlsxResult } from "@/services/reports/deliver-xlsx";
import { sanitizeArtifactFilename } from "@/services/sandbox/tool-registry";

export function sanitizeXlsxFilename(raw: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.(xlsx?|csv|numbers|ods)$/i, "");
  const safe = sanitizeArtifactFilename(stem);
  if (!safe) return "";
  return sanitizeArtifactFilename(`${safe.slice(0, 110)}.xlsx`) || "";
}

const DESCRIPTION = [
  "Build a real multi-sheet Excel workbook (.xlsx) with typed cells.",
  "",
  "PREFER THIS OVER report_render_csv FOR ANY ANALYST DELIVERABLE. A CSV can only",
  "carry text, so every number lands unsummable, every date is re-guessed by the",
  "opener's locale, and the customer re-types the header and reformats the columns",
  "by hand — the work the export was supposed to save. Here a number is a number, a",
  "date is a real date, money reads as money, and the header row arrives bold and",
  "frozen. Use render_csv only when the customer explicitly asks for a CSV or is",
  "feeding a system that requires one.",
  "",
  "Input fields:",
  "  - filename (string, ≤120): output name; the `.xlsx` extension is forced.",
  "  - sheets (array, 1-10): one entry per TAB in the workbook. Use several tabs",
  "    when the data is genuinely different shapes (e.g. 'Spend by campaign' and",
  "    'Spend by week') instead of stacking them on one sheet with blank rows.",
  "  - sheets[].name (string, ≤31): the tab name. Must be unique and must not",
  "    contain : \\ / ? * [ ] — Excel refuses to open a workbook that breaks either.",
  "  - sheets[].columns (array, 1-50): one entry per column.",
  "      - header (string): the column title.",
  "      - type: 'text' (default) | 'number' | 'money' | 'percent' | 'date'.",
  "        This is what makes the file a spreadsheet rather than a table of strings,",
  "        so set it deliberately on every column.",
  "      - width (int 4-80, optional): column width. Defaults are sensible; widen a",
  "        column that holds long text.",
  "  - sheets[].rows (array, ≤5000 per sheet): each row is an array of cells with",
  "    exactly one cell per column (jagged rows are rejected). Pass a cell as a",
  "    JSON number for numeric columns and as 'YYYY-MM-DD' for date columns; null",
  "    or \"\" leaves the cell empty.",
  "",
  "TYPE RULES that decide whether the sheet is usable:",
  "  - number/money: pass the raw JSON number — 1234.5, NOT \"$1,234.50\". The",
  "    money format adds the grouping and decimals on open.",
  "  - percent: pass the FRACTION — 0.42 renders as 42%. Passing 42 renders 4200%.",
  "  - date: pass 'YYYY-MM-DD'. Do not pre-format dates for a locale.",
  "  - A value that does not fit its column type is written as text rather than",
  "    dropped, so a stray 'n/a' in a number column survives and is visible.",
  "",
  "Total size across all sheets is capped at 20000 cells per call. If an export",
  "would exceed that, narrow it to what the customer actually asked about rather",
  "than splitting a dump across calls.",
  "",
  "Returns: { artifact_id, filename, bytes, sheets:[{name, rows, columns}] }.",
  "Report the per-sheet row counts back to the customer; never claim a row count",
  "you did not send.",
  "",
  "DELIVERY: on success the platform automatically attaches the workbook as a",
  "downloadable chip directly under this message. Refer to it by filename and say",
  "it is attached below. There is NO 'Files' or 'Downloads' tab — the chip on this",
  "message is the only location.",
  "",
  "Errors: missing_run_ctx, filename_invalid, invalid_input, xlsx_render_failed,",
  "xlsx_too_large, storage_upload_failed, artifact_row_failed.",
].join("\n");

export const renderXlsxTool: ToolSpec<RenderXlsxInput, DeliverXlsxResult> = {
  name: "report_render_xlsx",
  effect: "write",
  description: DESCRIPTION,
  input_schema: renderXlsxInputSchema,
  async execute(ctx, input) {
    if (!ctx.run_id) {
      throw new ExpectedToolError(
        "missing_run_ctx",
        "report.render_xlsx requires an active run_id in context.",
      );
    }
    const filename = sanitizeXlsxFilename(input.filename);
    if (!filename) {
      throw new ExpectedToolError(
        "filename_invalid",
        "filename must contain at least one letter or digit.",
      );
    }
    return deliverXlsx(
      { tenant_id: ctx.tenant_id, run_id: ctx.run_id, log: ctx.log },
      input,
      filename,
    );
  },
};
