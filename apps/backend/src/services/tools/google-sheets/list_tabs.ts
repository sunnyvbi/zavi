
import { z } from "zod";
import { getSpreadsheetTabs } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  spreadsheet_id: z
    .string()
    .min(10)
    .describe("The Google Sheets spreadsheet id — the long id segment in the sheet's URL, e.g. https://docs.google.com/spreadsheets/d/<spreadsheet_id>/edit"),
});

export const gsListTabsTool: ToolSpec = {
  name: "google_sheets_list_tabs",
  effect: "read",
  description:
    "List the tabs (sheets) in a Google Sheets spreadsheet — title, sheetId, and row/column counts for each visible tab. Read-only via the Sheets API. Throws google_sheets_not_connected if OAuth is not yet wired, google_sheets_access_denied if the connected Google account can't open it.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { spreadsheet_id } = inputSchema.parse(input);
    const tabs = await getSpreadsheetTabs(ctx.tenant_id, spreadsheet_id);
    const visible = tabs.filter((t) => !t.hidden);
    return {
      spreadsheet_id,
      tab_count: visible.length,
      tabs: visible.map((t) => ({
        title: t.title,
        sheet_id: t.sheet_id,
        row_count: t.row_count,
        col_count: t.col_count,
      })),
    };
  },
};
