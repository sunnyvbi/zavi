
import {
  sanitizeFetchedContent,
  xmlEscapeContent,
} from "../../onboarding/enrichment/sanitize";

const DRIVE = "https://www.googleapis.com/drive/v3";
const SHEETS = "https://sheets.googleapis.com/v4";

const MAX_TABS = 10;
const MAX_ROWS_PER_TAB = 500;
const MAX_COLS = 60;
export const MAX_BODY_BYTES = 1 * 1024 * 1024;
const EXCERPT_BYTES = 48 * 1024;

export type GoogleFileRef = {
  file_id: string;
  kind: "document" | "spreadsheet" | "presentation" | "file" | "unknown";
  gid: string | null;
};

export type GoogleAuth = {
  access_token: string;
  account_email: string | null;
};

export type GoogleReadResult =
  | {
      status: "ok";
      file_id: string;
      name: string;
      mime_type: string;
      body_text: string;
    }
  | {
      status: "access_required" | "auth_stale" | "unsupported" | "error";
      file_id: string;
      message: string;
    };

export function parseGoogleFileUrl(rawUrl: string): GoogleFileRef | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== "docs.google.com" && host !== "drive.google.com") return null;

  const gid = /(?:^|[#&?])gid=(\d+)/.exec(u.hash || u.search)?.[1] ?? null;

  const path = u.pathname;
  const d = /^\/(document|spreadsheets|presentation|file)\/(?:u\/\d+\/)?d\/([\w-]{10,})/.exec(
    path,
  );
  if (d) {
    const kind =
      d[1] === "document"
        ? "document"
        : d[1] === "spreadsheets"
          ? "spreadsheet"
          : d[1] === "presentation"
            ? "presentation"
            : "file";
    return { file_id: d[2], kind, gid };
  }
  if (path === "/open" || path === "/uc") {
    const id = u.searchParams.get("id");
    if (id && /^[\w-]{10,}$/.test(id)) return { file_id: id, kind: "unknown", gid };
  }
  const folder = /^\/drive\/(?:u\/\d+\/)?folders\/([\w-]{10,})/.exec(path);
  if (folder) return { file_id: folder[1], kind: "unknown", gid };
  return null;
}

function accessRequiredMessage(file_id: string, account_email: string | null): string {
  const who = account_email ? `the connected Google account (${account_email})` : "the connected Google account";
  return (
    `Zavi can't open this Google file (id ${file_id}) — ${who} doesn't have access. ` +
    `Most likely causes, in order: ` +
    `(1) ask the doc owner to share it with ${account_email ?? "the connected account"} (Viewer is enough), then re-send the link; ` +
    `(2) reconnect Google Drive in Settings with an account that can open this doc; ` +
    `(3) the link is wrong or the file was deleted. Relay the matching instruction to the user.`
  );
}

export function wrap(text: string): string {
  const sanitized = sanitizeFetchedContent(text);
  const escaped = xmlEscapeContent(sanitized);
  const trimmed =
    escaped.length > EXCERPT_BYTES
      ? `${escaped.slice(0, EXCERPT_BYTES)} …[truncated]`
      : escaped;
  return `<untrusted_web_content>\n${trimmed}\n</untrusted_web_content>`;
}

type DriveMeta = {
  id: string;
  name: string;
  mimeType: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
};

async function gFetch(url: string, token: string, fetchFn: typeof fetch): Promise<Response> {
  return fetchFn(url, { headers: { authorization: `Bearer ${token}` } });
}

async function getMeta(
  file_id: string,
  token: string,
  fetchFn: typeof fetch,
): Promise<{ ok: true; meta: DriveMeta } | { ok: false; status: number }> {
  const res = await gFetch(
    `${DRIVE}/files/${encodeURIComponent(file_id)}?fields=id,name,mimeType,shortcutDetails&supportsAllDrives=true`,
    token,
    fetchFn,
  );
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, meta: (await res.json()) as DriveMeta };
}

async function exportText(
  file_id: string,
  mimes: string[],
  token: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  for (const m of mimes) {
    const res = await gFetch(
      `${DRIVE}/files/${encodeURIComponent(file_id)}/export?mimeType=${encodeURIComponent(m)}&supportsAllDrives=true`,
      token,
      fetchFn,
    );
    if (res.ok) {
      const text = await res.text();
      if (text.length <= MAX_BODY_BYTES) return text;
      return text.slice(0, MAX_BODY_BYTES);
    }
  }
  return null;
}

async function readSpreadsheet(
  file_id: string,
  gid: string | null,
  token: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  const metaRes = await gFetch(
    `${SHEETS}/spreadsheets/${encodeURIComponent(file_id)}?fields=sheets.properties(sheetId,title,hidden,gridProperties(rowCount,columnCount))`,
    token,
    fetchFn,
  );
  if (!metaRes.ok) return null;
  const meta = (await metaRes.json()) as {
    sheets?: Array<{
      properties: {
        sheetId: number;
        title: string;
        hidden?: boolean;
        gridProperties?: { rowCount?: number; columnCount?: number };
      };
    }>;
  };
  let sheets = (meta.sheets ?? []).map((s) => s.properties).filter((p) => !p.hidden);
  if (gid !== null) {
    const hit = sheets.find((p) => String(p.sheetId) === gid);
    if (!hit) return null;
    sheets = [hit];
  }
  const droppedTabs = Math.max(0, sheets.length - MAX_TABS);
  sheets = sheets.slice(0, MAX_TABS);
  if (sheets.length === 0) return null;

  const colLetter = (n: number): string => {
    let s = "";
    for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) {
      s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
    }
    return s;
  };
  const ranges = sheets
    .map(
      (p) =>
        `ranges=${encodeURIComponent(`'${p.title.replace(/'/g, "''")}'!A1:${colLetter(MAX_COLS)}${MAX_ROWS_PER_TAB}`)}`,
    )
    .join("&");
  const valsRes = await gFetch(
    `${SHEETS}/spreadsheets/${encodeURIComponent(file_id)}/values:batchGet?${ranges}&majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
    token,
    fetchFn,
  );
  if (!valsRes.ok) return null;
  const vals = (await valsRes.json()) as {
    valueRanges?: Array<{ range?: string; values?: unknown[][] }>;
  };

  const parts: string[] = [];
  (vals.valueRanges ?? []).forEach((vr, i) => {
    const p = sheets[i];
    const rows = vr.values ?? [];
    const total = p.gridProperties?.rowCount ?? rows.length;
    parts.push(`## Tab: ${p.title}`);
    for (const row of rows) {
      parts.push(row.map((c) => String(c ?? "")).join("\t"));
    }
    if (total > MAX_ROWS_PER_TAB) {
      parts.push(`[truncated: showing first ${MAX_ROWS_PER_TAB} of ${total} rows]`);
    }
    parts.push("");
  });
  if (droppedTabs > 0) parts.push(`[truncated: ${droppedTabs} more tab(s) not shown]`);
  const out = parts.join("\n");
  return out.length > MAX_BODY_BYTES ? out.slice(0, MAX_BODY_BYTES) : out;
}

export async function readGoogleFile(
  ref: GoogleFileRef,
  auth: GoogleAuth,
  fetchFn: typeof fetch = fetch,
): Promise<GoogleReadResult> {
  const fail = (
    status: "access_required" | "auth_stale" | "unsupported" | "error",
    message: string,
  ): GoogleReadResult => ({ status, file_id: ref.file_id, message });

  const token = auth.access_token;

  let metaRes = await getMeta(ref.file_id, token, fetchFn);
  if (!metaRes.ok) {
    if (metaRes.status === 401) {
      return fail("auth_stale", "Google rejected the connected account's token (stale).");
    }
    if (metaRes.status === 403 || metaRes.status === 404) {
      return fail("access_required", accessRequiredMessage(ref.file_id, auth.account_email));
    }
    return fail("error", `Google Drive metadata error: HTTP ${metaRes.status}`);
  }
  let meta = metaRes.meta;

  if (meta.mimeType === "application/vnd.google-apps.shortcut" && meta.shortcutDetails?.targetId) {
    const target = await getMeta(meta.shortcutDetails.targetId, token, fetchFn);
    if (!target.ok) {
      if (target.status === 401) {
        return fail("auth_stale", "Google rejected the connected account's token (stale).");
      }
      if (target.status === 403 || target.status === 404) {
        return fail("access_required", accessRequiredMessage(ref.file_id, auth.account_email));
      }
      return fail("error", `Google Drive metadata error on the shortcut's target: HTTP ${target.status}`);
    }
    meta = target.meta;
  }

  if (meta.mimeType === "application/vnd.google-apps.folder") {
    return fail(
      "unsupported",
      "That's a Drive folder link. Folder listing isn't supported — ask the user to paste a link to a specific doc/sheet.",
    );
  }

  let text: string | null = null;
  switch (meta.mimeType) {
    case "application/vnd.google-apps.document":
      text = await exportText(meta.id, ["text/markdown", "text/plain"], token, fetchFn);
      break;
    case "application/vnd.google-apps.spreadsheet":
      text = await readSpreadsheet(meta.id, ref.gid, token, fetchFn);
      break;
    case "application/vnd.google-apps.presentation":
      text = await exportText(meta.id, ["text/plain"], token, fetchFn);
      break;
    default: {
      if (/^(text\/|application\/json)/.test(meta.mimeType)) {
        const res = await gFetch(
          `${DRIVE}/files/${encodeURIComponent(meta.id)}?alt=media&supportsAllDrives=true`,
          token,
          fetchFn,
        );
        if (res.ok) {
          const raw = await res.text();
          text = raw.length > MAX_BODY_BYTES ? raw.slice(0, MAX_BODY_BYTES) : raw;
        }
      } else {
        return fail(
          "unsupported",
          `This Drive file is ${meta.mimeType} — Zavi reads Google Docs, Sheets, Slides, and plain-text files. Ask the user to paste the content or export it as a Google Doc.`,
        );
      }
    }
  }

  if (text === null) {
    return fail("error", "Google export failed — the file may be too large, in an unsupported format, or the linked tab no longer exists.");
  }

  return {
    status: "ok",
    file_id: meta.id,
    name: meta.name,
    mime_type: meta.mimeType,
    body_text: wrap(`# ${meta.name}\n\n${text}`),
  };
}

export const MAX_FIND_RESULTS = 10;
const MAX_NAME_CHARS = 200;

export type GoogleFileHit = {
  file_id: string;
  name: string;
  mime_type: string;
  modified_time: string | null;
  web_view_link: string | null;
};

export type GoogleFindResult =
  | {
      status: "ok";
      files: GoogleFileHit[];
      truncated: boolean;
      notes: string[];
    }
  | { status: "auth_stale" | "error"; message: string };

export function escapeDriveQueryTerm(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function buildDriveSearchQuery(term: string): string {
  const t = escapeDriveQueryTerm(term.trim());
  return `trashed = false and (name contains '${t}' or fullText contains '${t}')`;
}

function truncateName(name: string): string {
  return name.length > MAX_NAME_CHARS
    ? `${name.slice(0, MAX_NAME_CHARS)} …[name truncated]`
    : name;
}

type DriveListResponse = {
  files?: Array<{
    id?: string;
    name?: string;
    mimeType?: string;
    modifiedTime?: string;
    webViewLink?: string;
  }>;
  incompleteSearch?: boolean;
};

export async function findGoogleFiles(
  term: string,
  auth: GoogleAuth,
  fetchFn: typeof fetch = fetch,
): Promise<GoogleFindResult> {
  if (term.trim().length === 0) {
    return { status: "error", message: "Search term is empty." };
  }
  const params = new URLSearchParams({
    q: buildDriveSearchQuery(term),
    pageSize: String(MAX_FIND_RESULTS + 1),
    fields: "files(id,name,mimeType,modifiedTime,webViewLink),incompleteSearch",
    orderBy: "modifiedTime desc",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    corpora: "allDrives",
  });
  const res = await gFetch(`${DRIVE}/files?${params.toString()}`, auth.access_token, fetchFn);
  if (!res.ok) {
    if (res.status === 401) {
      return {
        status: "auth_stale",
        message: "Google rejected the connected account's token (stale).",
      };
    }
    const detail = (await res.text().catch(() => "")).slice(0, 400);
    return {
      status: "error",
      message: `Google Drive search failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
    };
  }
  const body = (await res.json()) as DriveListResponse;
  const all = body.files ?? [];
  const truncated = all.length > MAX_FIND_RESULTS;
  const files: GoogleFileHit[] = all.slice(0, MAX_FIND_RESULTS).map((f) => ({
    file_id: f.id ?? "",
    name: truncateName(f.name ?? ""),
    mime_type: f.mimeType ?? "",
    modified_time: f.modifiedTime ?? null,
    web_view_link: f.webViewLink ?? null,
  }));
  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `[truncated: showing the ${MAX_FIND_RESULTS} most recently modified matches; more exist — narrow the search term]`,
    );
  }
  if (body.incompleteSearch) {
    notes.push(
      "[incomplete: Google could not search every drive this account can reach, so a short or empty result is NOT proof the document is absent]",
    );
  }
  return { status: "ok", files, truncated, notes };
}
