
import writeXlsxFile from "write-excel-file/node";
import { neutralizeFormula } from "./csv";
import type { RenderXlsxInput, XlsxColumnType } from "./schema";

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const OOXML_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const NUMBER_FORMAT: Partial<Record<XlsxColumnType, string>> = {
  number: "#,##0.###",
  money: "#,##0.00",
  percent: "0.0%",
  date: "yyyy-mm-dd",
};

const DEFAULT_WIDTH: Record<XlsxColumnType, number> = {
  text: 28,
  number: 14,
  money: 16,
  percent: 12,
  date: 14,
};

type Cell = {
  value?: string | number | Date;
  type?: typeof String | typeof Number | typeof Date;
  format?: string;
  fontWeight?: "bold";
};

function parseDate(raw: string | number): Date | null {
  if (typeof raw === "number") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = raw.trim();
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (ymd) {
    return new Date(Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3], 0, 0, 0));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toCell(raw: string | number | boolean | null, type: XlsxColumnType): Cell {
  if (raw === null || raw === "") return {};

  if (type === "text") {
    return { value: neutralizeFormula(String(raw)), type: String };
  }

  if (type === "date") {
    if (typeof raw === "boolean") return { value: neutralizeFormula(String(raw)), type: String };
    const d = parseDate(raw);
    return d
      ? { value: d, type: Date, format: NUMBER_FORMAT.date }
      : { value: neutralizeFormula(String(raw)), type: String };
  }

  if (typeof raw === "boolean") return { value: neutralizeFormula(String(raw)), type: String };
  const n =
    typeof raw === "number"
      ? raw
      :
        Number(raw.replace(/[,$£€\s]/g, "").replace(/%$/, ""));
  if (typeof raw === "string" && (raw.trim() === "" || !Number.isFinite(n))) {
    return { value: neutralizeFormula(raw), type: String };
  }
  if (!Number.isFinite(n)) return { value: neutralizeFormula(String(raw)), type: String };
  return { value: n, type: Number, format: NUMBER_FORMAT[type] };
}

export async function buildXlsx(input: RenderXlsxInput): Promise<Buffer> {
  const sheets = input.sheets.map((sheet) => {
    const header: Cell[] = sheet.columns.map((c) => ({
      value: neutralizeFormula(c.header),
      type: String,
      fontWeight: "bold" as const,
    }));
    const body: Cell[][] = sheet.rows.map((row) =>
      row.map((cell, i) => toCell(cell, sheet.columns[i]?.type ?? "text")),
    );
    return {
      sheet: sheet.name,
      data: [header, ...body],
      columns: sheet.columns.map((c) => ({ width: c.width ?? DEFAULT_WIDTH[c.type] })),
      stickyRowsCount: 1,
    };
  });

  const bytes = Buffer.from(await writeXlsxFile(sheets).toBuffer());

  if (bytes.byteLength === 0 || !bytes.subarray(0, 4).equals(OOXML_MAGIC)) {
    throw new Error("xlsx writer produced bytes that are not an OOXML container");
  }
  return bytes;
}
