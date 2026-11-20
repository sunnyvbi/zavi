
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import {
  renderCsvInputSchema,
  type RenderCsvInput,
} from "@/services/reports/schema";
import {
  deliverCsv,
  type DeliverCsvResult,
} from "@/services/reports/deliver-csv";
import { buildCsv, sanitizeCsvFilename } from "@/services/reports/csv";

const DESCRIPTION = [
  "Render tabular data to a downloadable CSV spreadsheet artifact.",
  "",
  "Use this when the user wants data they can open in Excel / Google Sheets and",
  "sort, filter, or pivot — e.g. an export of bookings, ad metrics, a cohort",
  "table, or a lead list. For a formatted narrative report, use report_render_pdf.",
  "",
  "Input fields:",
  "  - filename (string, ≤120): output name; the `.csv` extension is forced.",
  "  - columns (array, 1-50): the header row.",
  "  - rows (array, ≤5000): each row is an array of string cells; each row MUST",
  "    have exactly one cell per column (jagged rows are rejected).",
  "",
  "Numbers, dates, and money should be passed as strings (e.g. \"1200\", \"$1,200\").",
  "Cells are automatically quoted (RFC-4180) and any cell that would be read as a",
  "spreadsheet formula is neutralized, so paste-safe.",
  "",
  "Returns: { artifact_id, filename, bytes }.",
  "",
  "DELIVERY: on success the platform automatically attaches the CSV as a",
  "downloadable chip directly under this message. Refer to it by filename and say",
  "it is attached below. There is NO 'Files' or 'Downloads' tab — the chip on this",
  "message is the only location.",
  "",
  "Errors: missing_run_ctx, filename_invalid, invalid_input.",
].join("\n");

export const renderCsvTool: ToolSpec<RenderCsvInput, DeliverCsvResult> = {
  name: "report_render_csv",
  effect: "write",
  description: DESCRIPTION,
  input_schema: renderCsvInputSchema,
  async execute(ctx, input) {
    if (!ctx.run_id) {
      throw new ExpectedToolError(
        "missing_run_ctx",
        "report.render_csv requires an active run_id in context.",
      );
    }
    const filename = sanitizeCsvFilename(input.filename);
    if (!filename) {
      throw new ExpectedToolError(
        "filename_invalid",
        "filename must contain at least one letter or digit.",
      );
    }
    const csv = buildCsv(input.columns, input.rows);
    return deliverCsv(
      { tenant_id: ctx.tenant_id, run_id: ctx.run_id },
      { filename, csv },
    );
  },
};
