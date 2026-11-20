
export const CSV_ROW_CAP = 200;

export function parseCsv(text: string, maxRows = CSV_ROW_CAP): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") endField();
    else if (ch === "\n") endRow();
    else if (ch !== "\r") field += ch;
  }
  if (rows.length < maxRows && (field !== "" || row.length > 0)) endRow();
  return rows;
}

export function isCsv(a: { mime: string; filename: string }): boolean {
  return a.mime.toLowerCase() === "text/csv" || /\.csv$/i.test(a.filename);
}

export function csvPreview(text: string, rows: number): { header: string[]; body: string[][]; more: boolean } {
  const all = parseCsv(text, rows + 2);
  const [header = [], ...body] = all;
  return { header, body: body.slice(0, rows), more: body.length > rows };
}
