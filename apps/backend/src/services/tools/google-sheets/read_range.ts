
import { z } from "zod";
import { getRangeValues } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const MAX_ROWS = 1000;
const MAX_COLS = 60;

const inputSchema = z.object({
  spreadsheet_id: z
    .string()
    .min(10)
    .describe("The Google Sheets spreadsheet id — the long id segment in the sheet's URL, e.g. https://docs.google.com/spreadsheets/d/<spreadsheet_id>/edit"),
  range: z
    .string()
    .min(1)
    .max(200)
    .describe("A1 notation range, e.g. 'Sheet1!A1:D50'. Quote the tab name if it has spaces, e.g. \"'My Tab'!A1:C10\". Get valid tab names from google_sheets_list_tabs first."),
});

export const gsReadRangeTool: ToolSpec = {
  name: "google_sheets_read_range",
  effect: "read",
  description:
    `Read cell values for an explicit A1 range from a Google Sheets spreadsheet (e.g. 'Sheet1!A1:D50'). Read-only via the Sheets API, formatted values (not raw formulas). Hard-capped at ${MAX_ROWS} rows × ${MAX_COLS} columns — a larger range is truncated, not rejected. Throws google_sheets_not_connected if OAuth is not yet wired, google_sheets_access_denied if the connected Google account can't open it, google_sheets_invalid_range if the range isn't valid A1 notation.`,
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { spreadsheet_id, range } = inputSchema.parse(input);
    const result = await getRangeValues(ctx.tenant_id, spreadsheet_id, range);

    const rowsTotal = result.values.length;
    const truncatedRows = rowsTotal > MAX_ROWS;
    const cappedRows = result.values.slice(0, MAX_ROWS);

    let truncatedCols = false;
    const values = cappedRows.map((row) => {
      if (row.length > MAX_COLS) truncatedCols = true;
      return row.slice(0, MAX_COLS);
    });

    return {
      spreadsheet_id,
      range: result.range,
      row_count: values.length,
      values,
      truncated: truncatedRows || truncatedCols,
      ...(truncatedRows ? { rows_dropped: rowsTotal - MAX_ROWS } : {}),
    };
  },
};
