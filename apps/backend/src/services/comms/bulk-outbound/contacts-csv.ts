
import { parseCsv } from "@/services/knowledge-import/scrub";
import { normalizeEmail } from "./cohort";
import { CSV_MAX_BYTES } from "./config";
import { BulkEmailError } from "./errors";

const SAMPLES_PER_COLUMN = 5;

export type CsvColumnPreview = {
  header: string;
  samples: string[];
  has_addresses: boolean;
};

export type CsvPreview = {
  columns: CsvColumnPreview[];
  auto_column: string | null;
  row_count: number;
  preview_rows: string[][];
};

const PREVIEW_ROWS = 4;

type Table = { headers: string[]; rows: string[][] };

const DELIMITERS = [",", ";", "\t"] as const;

function sniffDelimiter(line: string): string {
  let best = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === d) count += 1;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function readTable(buf: Buffer): Table {
  if (buf.length > CSV_MAX_BYTES) {
    throw new BulkEmailError("csv_too_large", "That file is larger than 2 MB. Split it into smaller files and upload each one.", 413);
  }
  let text = buf.toString("utf8").replace(/^\uFEFF/, "");
  let delimiter: string | null = null;
  const sep = /^\s*"?sep=(.)"?[^\S\r\n]*(\r\n|\r|\n)/i.exec(text);
  if (sep) {
    delimiter = sep[1];
    text = text.slice(sep[0].length);
  }
  const firstLine = text.split(/\r\n|\r|\n/).find((l) => l.trim() !== "") ?? "";
  const table = parseCsv(text, delimiter ?? sniffDelimiter(firstLine));
  if (!table || table.length === 0) {
    throw new BulkEmailError("csv_unreadable", "We could not read that file. Save it as a CSV and try again.");
  }
  const nonEmpty = table.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) {
    throw new BulkEmailError("csv_no_header", "That file has no header row. Add a first row that names each column.");
  }
  const headers = nonEmpty[0].map((h, i) => h.trim() || `Column ${i + 1}`);
  return { headers, rows: nonEmpty.slice(1) };
}

export function addressIn(raw: string): string | null {
  let v = raw.trim();
  const angled = /<([^<>]+)>\s*$/.exec(v);
  if (angled) v = angled[1];
  v = v.trim().replace(/^mailto:/i, "");
  if (/[;,<>"\u0000-\u0020\u007f]/.test(v)) return null;
  return normalizeEmail(v);
}

export function previewCsv(buf: Buffer): CsvPreview {
  const { headers, rows } = readTable(buf);
  const columns: CsvColumnPreview[] = headers.map((header, i) => {
    const samples: string[] = [];
    let has_addresses = false;
    for (const r of rows) {
      const v = (r[i] ?? "").trim();
      if (!v) continue;
      if (samples.length < SAMPLES_PER_COLUMN) samples.push(v.slice(0, 120));
      if (!has_addresses && addressIn(v)) has_addresses = true;
      if (has_addresses && samples.length >= SAMPLES_PER_COLUMN) break;
    }
    return { header, samples, has_addresses };
  });
  const withAddresses = columns.filter((c) => c.has_addresses);
  if (withAddresses.length === 0) {
    throw new BulkEmailError("csv_no_address_column", "We could not find a column of email addresses in that file.");
  }
  const named = columns.filter((c) => c.header.toLowerCase() === "email");
  const auto_column =
    named.length === 1 && named[0].has_addresses && withAddresses.length === 1 ? named[0].header : null;
  const preview_rows = rows.slice(0, PREVIEW_ROWS).map((r) => headers.map((_, i) => (r[i] ?? "").trim().slice(0, 120)));
  return { columns, auto_column, row_count: rows.length, preview_rows };
}

export function csvColumnValues(buf: Buffer, column: string): string[] {
  const { headers, rows } = readTable(buf);
  const index = columnIndex(headers, column);
  if (index < 0) {
    throw new BulkEmailError("csv_column_not_found", "Choose which column holds the email addresses.");
  }
  return rows.map((r) => r[index] ?? "");
}

function columnIndex(headers: string[], column: string): number {
  const want = column.trim().toLowerCase();
  const matches = headers.map((h, i) => (h.toLowerCase() === want ? i : -1)).filter((i) => i >= 0);
  return matches.length === 1 ? matches[0] : -1;
}

export const CONTACT_NAME_MAX = 200;

export function cleanContactName(...parts: unknown[]): string | null {
  const joined = parts
    .map((p) => (typeof p === "string" ? p : ""))
    .join(" ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CONTACT_NAME_MAX)
    .trim();
  return joined || null;
}

export function csvContactNames(
  buf: Buffer,
  firstColumn: string | null,
  lastColumn: string | null,
  fullColumn: string | null = null,
): (string | null)[] {
  if (fullColumn && (firstColumn || lastColumn)) {
    throw new BulkEmailError("csv_name_columns_conflict", "Pick either a full name column or first and last name columns, not both.");
  }
  const { headers, rows } = readTable(buf);
  const pick = (column: string | null): number => {
    if (!column) return -1;
    const index = columnIndex(headers, column);
    if (index < 0) throw new BulkEmailError("csv_name_column_not_found", "That name column was not found in the file.");
    return index;
  };
  const full = pick(fullColumn);
  if (full >= 0) {
    return rows.map((r) => cleanContactName(r[full]));
  }
  const first = pick(firstColumn);
  const last = pick(lastColumn);
  return rows.map((r) => cleanContactName(first >= 0 ? r[first] : "", last >= 0 && last !== first ? r[last] : ""));
}

export type CleanedAddresses = {
  emails: string[];
  names?: (string | null)[];
  invalid: number;
  duplicates: number;
  over_limit: number;
};

export function cleanAddresses(values: readonly unknown[], cap: number, rawNames?: readonly unknown[]): CleanedAddresses {
  const seen = new Map<string, number>();
  const emails: string[] = [];
  const names: (string | null)[] = [];
  let invalid = 0;
  let duplicates = 0;
  let over_limit = 0;
  values.forEach((raw, i) => {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return;
    const email = addressIn(text);
    if (!email) {
      invalid += 1;
      return;
    }
    const name = rawNames ? cleanContactName(rawNames[i]) : null;
    const at = seen.get(email);
    if (at !== undefined) {
      duplicates += 1;
      if (at >= 0 && names[at] === null && name) names[at] = name;
      return;
    }
    if (emails.length >= cap) {
      over_limit += 1;
      seen.set(email, -1);
    } else {
      seen.set(email, emails.length);
      emails.push(email);
      names.push(name);
    }
  });
  return { emails, invalid, duplicates, over_limit, ...(rawNames ? { names } : {}) };
}
