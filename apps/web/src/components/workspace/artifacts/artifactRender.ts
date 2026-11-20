
export const UI_BLOCK_MIME = "application/vnd.zavi.ui+json";
export const PAGE_MIME = "application/vnd.zavi.page";

export const MAX_INLINE_BYTES = 8 * 1024 * 1024;

export type ArtifactRenderMode =
  | "html"
  | "markdown"
  | "csv"
  | "text"
  | "pdf"
  | "image"
  | "video"
  | "ui-block"
  | "page"
  | "unsupported";

export function artifactRenderMode(mime: string, filename: string): ArtifactRenderMode {
  const m = (mime || "").toLowerCase().split(";")[0].trim();
  const f = (filename || "").toLowerCase();
  const ends = (...exts: string[]) => exts.some((ext) => f.endsWith(ext));

  if (m === UI_BLOCK_MIME) return "ui-block";
  if (m === PAGE_MIME) return "page";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m === "application/pdf" || ends(".pdf")) return "pdf";
  if (m === "text/html" || ends(".html", ".htm")) return "html";
  if (m === "text/markdown" || ends(".md", ".markdown")) return "markdown";
  if (m === "text/csv" || ends(".csv")) return "csv";
  if (
    m === "text/plain" ||
    m === "application/json" ||
    m === "text/json" ||
    ends(".txt", ".json", ".log")
  ) {
    return "text";
  }
  return "unsupported";
}

export function isTextRenderMode(mode: ArtifactRenderMode): boolean {
  return mode === "html" || mode === "markdown" || mode === "csv" || mode === "text";
}

export function isUrlRenderMode(mode: ArtifactRenderMode): boolean {
  return mode === "pdf" || mode === "image" || mode === "video";
}

export function parseCsv(text: string, maxRows = 200): string[][] {
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
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRow();
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (rows.length < maxRows && (field !== "" || row.length > 0)) endRow();
  return rows;
}
