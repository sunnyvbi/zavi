
export type ArtifactKind =
  | "Deck"
  | "Document"
  | "Spreadsheet"
  | "Image"
  | "Video"
  | "File";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "Deck",
  "Document",
  "Spreadsheet",
  "Image",
  "Video",
  "File",
];

export function artifactKind(mime: string, filename: string): ArtifactKind {
  const m = (mime || "").toLowerCase();
  const f = (filename || "").toLowerCase();

  if (m.startsWith("image/")) return "Image";
  if (m.startsWith("video/")) return "Video";

  if (m === "application/pdf" || f.endsWith(".pdf")) {
    return /(^|[^a-z])deck([^a-z]|$)|slides?/.test(f) ? "Deck" : "Document";
  }

  if (
    m === "text/csv" ||
    m === "application/vnd.ms-excel" ||
    m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    f.endsWith(".csv") ||
    f.endsWith(".xlsx")
  ) {
    return "Spreadsheet";
  }

  if (m === "text/html" || m === "text/markdown" || m === "text/plain" || f.endsWith(".html") || f.endsWith(".md")) {
    return "Document";
  }

  return "File";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function formatCreatedAt(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
