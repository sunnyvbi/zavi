
import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildXlsx, toCell, XLSX_MIME } from "../xlsx";
import { renderXlsxInputSchema, MAX_XLSX_TOTAL_CELLS } from "../schema";
import { sanitizeXlsxFilename } from "@/services/tools/report/render_xlsx";

function sheetXml(buf: Buffer, n = 1): string {
  const files = unzipSync(new Uint8Array(buf));
  return strFromU8(files[`xl/worksheets/sheet${n}.xml`]);
}
function cell(xml: string, ref: string): string {
  const m = new RegExp(`<c r="${ref}"[\\s\\S]*?(?:/>|</c>)`).exec(xml);
  return m ? m[0] : "";
}
function parse(input: unknown) {
  return renderXlsxInputSchema.parse(input);
}

const SHEET = {
  name: "Spend",
  columns: [
    { header: "Campaign", type: "text" as const },
    { header: "Spend", type: "money" as const },
    { header: "ROAS", type: "percent" as const },
    { header: "Day", type: "date" as const },
    { header: "Clicks", type: "number" as const },
  ],
  rows: [["Brand search", 1234.5, 0.42, "2026-08-01", 980]],
};

describe("xlsx — typed cells are the whole point", () => {
  it("writes a number as a NUMBER, not a string", async () => {
    const xml = sheetXml(await buildXlsx(parse({ filename: "x", sheets: [SHEET] })));
    expect(cell(xml, "B2")).toContain("<v>1234.5</v>");
    expect(cell(xml, "B2")).not.toContain('t="s"');
    expect(cell(xml, "E2")).toContain("<v>980</v>");
  });

  it("writes a date as a real Excel serial, not text", async () => {
    const xml = sheetXml(await buildXlsx(parse({ filename: "x", sheets: [SHEET] })));
    expect(cell(xml, "D2")).toContain("<v>46235</v>");
  });

  it("keeps that date serial stable regardless of the server timezone", async () => {
    const original = process.env.TZ;
    const serials: string[] = [];
    for (const tz of ["America/Los_Angeles", "Asia/Kolkata", "UTC"]) {
      process.env.TZ = tz;
      const xml = sheetXml(await buildXlsx(parse({ filename: "x", sheets: [SHEET] })));
      serials.push(cell(xml, "D2"));
    }
    process.env.TZ = original;
    expect(new Set(serials).size).toBe(1);
    expect(serials[0]).toContain("46235");
  });

  it("bolds and freezes the header row so a long export stays readable", async () => {
    const xml = sheetXml(await buildXlsx(parse({ filename: "x", sheets: [SHEET] })));
    expect(xml).toMatch(/<pane[^>]*ySplit="1"/);
    expect(cell(xml, "A1")).toMatch(/s="\d+"/);
  });

  it("sets column widths so nothing renders as ####", async () => {
    const xml = sheetXml(await buildXlsx(parse({ filename: "x", sheets: [SHEET] })));
    expect(xml).toMatch(/<col[^>]*width="/);
  });

  it("produces a real OOXML container", async () => {
    const buf = await buildXlsx(parse({ filename: "x", sheets: [SHEET] }));
    expect(buf.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(XLSX_MIME).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("writes every sheet as its own named tab", async () => {
    const buf = await buildXlsx(
      parse({
        filename: "x",
        sheets: [SHEET, { ...SHEET, name: "By week", rows: [["W31", 10, 0.1, "2026-07-27", 5]] }],
      }),
    );
    const wb = strFromU8(unzipSync(new Uint8Array(buf))["xl/workbook.xml"]);
    expect(wb).toContain('name="Spend"');
    expect(wb).toContain('name="By week"');
  });
});

describe("xlsx — coercion is forgiving in one direction only", () => {
  it("tolerates the currency and separators an agent naturally writes", () => {
    expect(toCell("$1,234.50", "money")).toMatchObject({ value: 1234.5, type: Number });
    expect(toCell("42%", "percent")).toMatchObject({ value: 42, type: Number });
  });

  it("keeps an unparseable value as TEXT rather than dropping or zeroing it", () => {
    expect(toCell("n/a", "number")).toMatchObject({ value: "n/a", type: String });
    expect(toCell("last Tuesday", "date")).toMatchObject({
      value: "last Tuesday",
      type: String,
    });
  });

  it("leaves an empty cell genuinely empty, so ISBLANK/COUNTA still work", () => {
    expect(toCell(null, "number")).toEqual({});
    expect(toCell("", "text")).toEqual({});
  });

  it("neutralizes a formula lead with the same rule as the CSV path", async () => {
    expect(toCell("=cmd|'/c calc'!A1", "text")).toMatchObject({
      value: "'=cmd|'/c calc'!A1",
    });
    const buf = await buildXlsx(
      parse({
        filename: "x",
        sheets: [{ name: "S", columns: [{ header: "=BAD()" }], rows: [["=cmd|calc"]] }],
      }),
    );
    const shared = strFromU8(unzipSync(new Uint8Array(buf))["xl/sharedStrings.xml"]);
    expect(shared).toContain("<t>'=cmd|calc</t>");
    expect(shared).toContain("<t>'=BAD()</t>");
    expect(sheetXml(buf)).not.toContain("<f>");
  });
});

describe("xlsx — schema guards", () => {
  const base = { name: "S", columns: [{ header: "A" }], rows: [] as unknown[][] };

  it("rejects jagged rows, which would shift every later cell one column left", () => {
    expect(() =>
      parse({
        filename: "x",
        sheets: [{ name: "S", columns: [{ header: "A" }, { header: "B" }], rows: [["only one"]] }],
      }),
    ).toThrow(/exactly one cell per column/);
  });

  it("rejects sheet names Excel refuses to open", () => {
    expect(() => parse({ filename: "x", sheets: [{ ...base, name: "Q3/Q4" }] })).toThrow(
      /forbids/,
    );
    expect(() =>
      parse({ filename: "x", sheets: [{ ...base }, { ...base }] }),
    ).toThrow(/duplicate sheet name/);
  });

  it("caps total cells across all sheets, and says what to do instead", () => {
    const cols = Array.from({ length: 50 }, (_, i) => ({ header: `c${i}` }));
    const rows = Array.from({ length: 500 }, () => cols.map(() => "x"));
    const sheets = Array.from({ length: 10 }, (_, i) => ({ name: `S${i}`, columns: cols, rows }));
    let msg = "";
    try {
      parse({ filename: "x", sheets });
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toContain(String(MAX_XLSX_TOTAL_CELLS));
    expect(msg).toMatch(/Narrow the export/);
  });
});

describe("xlsx — filename sanitization", () => {
  it("strips any path component and forces .xlsx", () => {
    expect(sanitizeXlsxFilename("../../etc/passwd")).toBe("passwd.xlsx");
    expect(sanitizeXlsxFilename("Q3 Spend.csv")).toBe("q3spend.xlsx");
    expect(sanitizeXlsxFilename("report.xlsx")).toBe("report.xlsx");
  });

  it("returns empty for a name with nothing usable, so the tool can reject it", () => {
    expect(sanitizeXlsxFilename("///")).toBe("");
    expect(sanitizeXlsxFilename("...")).toBe("");
  });
});
