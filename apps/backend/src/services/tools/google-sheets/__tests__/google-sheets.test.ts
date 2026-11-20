import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const getSpreadsheetTabsMock = vi.fn();
const getRangeValuesMock = vi.fn();
vi.mock("../_client", () => ({
  getSpreadsheetTabs: (...args: unknown[]) => getSpreadsheetTabsMock(...args),
  getRangeValues: (...args: unknown[]) => getRangeValuesMock(...args),
}));

import { gsListTabsTool } from "../list_tabs";
import { gsReadRangeTool } from "../read_range";

const ctx = { tenant_id: "t-1" } as any;

beforeEach(() => {
  getSpreadsheetTabsMock.mockReset();
  getRangeValuesMock.mockReset();
});

describe("gsListTabsTool", () => {
  it("maps visible tabs to {title, sheet_id, row_count, col_count}", async () => {
    getSpreadsheetTabsMock.mockResolvedValue([
      { sheet_id: 0, title: "Sheet1", hidden: false, row_count: 1000, col_count: 26 },
      { sheet_id: 1, title: "Archive", hidden: true, row_count: 50, col_count: 5 },
    ]);

    const out = (await gsListTabsTool.execute(ctx, { spreadsheet_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" })) as {
      tab_count: number;
      tabs: Array<{ title: string; sheet_id: number }>;
    };

    expect(out.tab_count).toBe(1);
    expect(out.tabs).toEqual([{ title: "Sheet1", sheet_id: 0, row_count: 1000, col_count: 26 }]);
    expect(getSpreadsheetTabsMock).toHaveBeenCalledWith("t-1", "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms");
  });

  it("propagates google_sheets_not_connected from the client (no fabricated data)", async () => {
    getSpreadsheetTabsMock.mockRejectedValue(
      new ExpectedToolError("google_sheets_not_connected", "not connected"),
    );
    await expect(gsListTabsTool.execute(ctx, { spreadsheet_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" })).rejects.toMatchObject({
      code: "google_sheets_not_connected",
    });
  });

  it("returns an empty tab list (not a crash) when the spreadsheet has none", async () => {
    getSpreadsheetTabsMock.mockResolvedValue([]);
    const out = (await gsListTabsTool.execute(ctx, { spreadsheet_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" })) as { tab_count: number; tabs: unknown[] };
    expect(out.tab_count).toBe(0);
    expect(out.tabs).toEqual([]);
  });
});

describe("gsReadRangeTool", () => {
  it("passes spreadsheet_id + range through to the client", async () => {
    getRangeValuesMock.mockResolvedValue({ range: "Sheet1!A1:B2", values: [["a", "b"], ["1", "2"]] });
    await gsReadRangeTool.execute(ctx, { spreadsheet_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms", range: "Sheet1!A1:B2" });
    expect(getRangeValuesMock).toHaveBeenCalledWith("t-1", "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms", "Sheet1!A1:B2");
  });

  it("returns rows/values with truncated:false under the cap", async () => {
    getRangeValuesMock.mockResolvedValue({ range: "Sheet1!A1:B2", values: [["a", "b"], ["1", "2"]] });
    const out = (await gsReadRangeTool.execute(ctx, { spreadsheet_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms", range: "Sheet1!A1:B2" })) as {
      row_count: number;
      values: unknown[][];
      truncated: boolean;
    };
    expect(out.row_count).toBe(2);
    expect(out.values).toEqual([["a", "b"], ["1", "2"]]);
    expect(out.truncated).toBe(false);
  });

  it("hard-caps rows at 1000 and reports rows_dropped", async () => {
    const values = Array.from({ length: 1500 }, (_, i) => [String(i)]);
    getRangeValuesMock.mockResolvedValue({ range: "Sheet1!A1:A1500", values });
    const out = (await gsReadRangeTool.execute(ctx, { spreadsheet_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms", range: "Sheet1!A1:A1500" })) as {
      row_count: number;
      truncated: boolean;
      rows_dropped: number;
    };
    expect(out.row_count).toBe(1000);
    expect(out.truncated).toBe(true);
    expect(out.rows_dropped).toBe(500);
  });

  it("hard-caps columns at 60 per row", async () => {
    const wideRow = Array.from({ length: 100 }, (_, i) => String(i));
    getRangeValuesMock.mockResolvedValue({ range: "Sheet1!A1:CV1", values: [wideRow] });
    const out = (await gsReadRangeTool.execute(ctx, { spreadsheet_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms", range: "Sheet1!A1:CV1" })) as {
      values: unknown[][];
      truncated: boolean;
    };
    expect(out.values[0]).toHaveLength(60);
    expect(out.truncated).toBe(true);
  });

  it("propagates google_sheets_invalid_range from the client (no fabricated data)", async () => {
    getRangeValuesMock.mockRejectedValue(
      new ExpectedToolError("google_sheets_invalid_range", "bad range"),
    );
    await expect(
      gsReadRangeTool.execute(ctx, { spreadsheet_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms", range: "not a range" }),
    ).rejects.toMatchObject({ code: "google_sheets_invalid_range" });
  });
});
