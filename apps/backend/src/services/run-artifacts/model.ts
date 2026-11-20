export type ArtifactKind =
  | "document"
  | "spreadsheet"
  | "image"
  | "presentation"
  | "website"
  | "dashboard"
  | "video"
  | "file";

export type ArtifactRow = {
  id: string;
  tenant_id: string;
  run_id: string;
  storage_path: string;
  bucket: string | null;
  filename: string;
  title: string | null;
  mime: string;
  bytes: number;
  created_at: string;
  updated_at: string | null;
  agent_slug: string | null;
  thread_id: string | null;
};

export function artifactKind(mime: string, filename: string): ArtifactKind {
  const normalizedMime = mime.toLowerCase();
  const normalizedFilename = filename.toLowerCase();
  if (normalizedMime === "application/vnd.zavi.ui+json") return "dashboard";
  if (normalizedMime.startsWith("image/")) return "image";
  if (normalizedMime.startsWith("video/")) return "video";
  if (
    normalizedMime.includes("presentation") ||
    normalizedFilename.endsWith(".pptx") ||
    /(^|[^a-z])deck([^a-z]|$)|slides?/.test(normalizedFilename)
  ) {
    return "presentation";
  }
  if (
    normalizedMime === "text/csv" ||
    normalizedMime.includes("spreadsheet") ||
    normalizedFilename.endsWith(".csv") ||
    normalizedFilename.endsWith(".xlsx")
  ) {
    return "spreadsheet";
  }
  if (normalizedMime === "text/html" || normalizedFilename.endsWith(".html")) {
    return "website";
  }
  if (
    normalizedMime === "application/pdf" ||
    normalizedMime === "text/markdown" ||
    normalizedMime === "text/plain" ||
    normalizedFilename.endsWith(".pdf") ||
    normalizedFilename.endsWith(".md")
  ) {
    return "document";
  }
  return "file";
}

function sourceTitle(slug: string | null, kind: "chat" | "task"): string {
  if (!slug) return kind === "chat" ? "Source chat" : "AI task";
  const name = slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return kind === "chat" ? `${name} chat` : `${name} task`;
}

export async function readableThreadIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: { from: (table: string) => any },
  rows: ReadonlyArray<Pick<ArtifactRow, "thread_id">>,
): Promise<Set<string> | null> {
  const ids = Array.from(
    new Set(rows.map((r) => r.thread_id).filter((id): id is string => typeof id === "string")),
  );
  if (ids.length === 0) return new Set();
  try {
    const { data, error } = await sb.from("agent_threads").select("id").in("id", ids);
    if (error) return null;
    return new Set(((data ?? []) as Array<{ id: string }>).map((r) => String(r.id)));
  } catch {
    return null;
  }
}

export function presentArtifact(
  row: ArtifactRow,
  previewUrl: string | null,
  readableThreads: ReadonlySet<string> | null = null,
) {
  const sourceKind = row.thread_id ? "chat" : "task";
  const teammateChat =
    !!row.thread_id && readableThreads !== null && !readableThreads.has(row.thread_id);
  return {
    id: row.id,
    run_id: row.run_id,
    title: row.title?.trim() || row.filename.replace(/\.[^.]+$/, ""),
    filename: row.filename,
    mime: row.mime,
    type: artifactKind(row.mime, row.filename),
    bytes: row.bytes,
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
    preview_url: previewUrl,
    source: {
      kind: sourceKind,
      id: row.thread_id ?? row.run_id,
      title: teammateChat ? "a teammate's chat" : sourceTitle(row.agent_slug, sourceKind),
      href: teammateChat
        ? null
        : row.thread_id && row.agent_slug
          ? `/workspace?agent=${encodeURIComponent(row.agent_slug)}&thread=${encodeURIComponent(row.thread_id)}`
          : `/workspace/runs/${encodeURIComponent(row.run_id)}`,
    },
  };
}
