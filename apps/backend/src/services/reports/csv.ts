
const MAX_FILENAME = 120;

const FORMULA_LEAD = /^[\s]*[=+\-@\t\r]/;

export function neutralizeFormula(value: string): string {
  const v = value ?? "";
  return FORMULA_LEAD.test(v) ? `'${v}` : v;
}

export function csvField(value: string): string {
  const v = neutralizeFormula(value);
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export function buildCsv(columns: string[], rows: string[][]): string {
  const lines = [
    columns.map(csvField).join(","),
    ...rows.map((r) => r.map(csvField).join(",")),
  ];
  return lines.join("\r\n");
}

export function sanitizeCsvFilename(raw: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  let name = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[.]+/, "")
    .replace(/\.[a-z0-9]+$/i, "");
  name = name.slice(0, MAX_FILENAME - 4);
  if (!name) return "";
  return `${name}.csv`;
}
