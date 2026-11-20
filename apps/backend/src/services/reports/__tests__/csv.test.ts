import { describe, it, expect } from "vitest";
import { csvField, buildCsv, sanitizeCsvFilename } from "../csv";

describe("csvField — RFC-4180 + formula-injection", () => {
  it("neutralizes formula-leading cells (Excel/Sheets RCE class)", () => {
    expect(csvField("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvField("+1+2")).toBe("'+1+2");
    expect(csvField("-2+3")).toBe("'-2+3");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField("  =evil()")).toBe("'  =evil()");
  });
  it("quotes fields with comma/quote/newline and doubles internal quotes", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('she said "hi"')).toBe('"she said ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });
  it("leaves plain text untouched", () => {
    expect(csvField("North")).toBe("North");
    expect(csvField("1200")).toBe("1200");
    expect(csvField("")).toBe("");
  });
  it("quotes a formula cell that ALSO needs quoting (prefix then quote)", () => {
    expect(csvField("=a,b")).toBe("\"'=a,b\"");
  });
});

describe("buildCsv", () => {
  it("builds a CRLF RFC-4180 doc with a header row + escaped cells", () => {
    const out = buildCsv(
      ["Region", "Note"],
      [
        ["North", "=danger"],
        ["South", "a,b"],
      ],
    );
    expect(out).toBe('Region,Note\r\nNorth,\'=danger\r\nSouth,"a,b"');
  });
});

describe("sanitizeCsvFilename", () => {
  it("strips path components (traversal defense) and forces .csv", () => {
    expect(sanitizeCsvFilename("../../etc/passwd")).toBe("passwd.csv");
    expect(sanitizeCsvFilename("/a/b/report")).toBe("report.csv");
    expect(sanitizeCsvFilename("q1-report.csv")).toBe("q1-report.csv");
    expect(sanitizeCsvFilename("data.xlsx")).toBe("data.csv");
  });
  it("lowercases + drops unsafe chars", () => {
    expect(sanitizeCsvFilename("My Report!!")).toBe("myreport.csv");
  });
  it("returns '' for names that reduce to nothing (caller throws filename_invalid)", () => {
    expect(sanitizeCsvFilename("")).toBe("");
    expect(sanitizeCsvFilename("...")).toBe("");
    expect(sanitizeCsvFilename("/// ")).toBe("");
  });
  it("recovers a usable name from an extension-only input", () => {
    expect(sanitizeCsvFilename(".csv")).toBe("csv.csv");
  });
});
