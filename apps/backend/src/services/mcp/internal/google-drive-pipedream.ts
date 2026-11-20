
import { wrap, MAX_BODY_BYTES } from "./google-drive-core";
import type { GoogleFileRef, GoogleReadResult } from "./google-drive-core";

export type PipedreamToolCaller = (
  tool_name: string,
  args: Record<string, unknown>,
) => Promise<{ is_error: boolean; content: string }>;

const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";
const SLIDES = "application/vnd.google-apps.presentation";
const FOLDER = "application/vnd.google-apps.folder";

function exportMimeFor(driveMime: string): string | null {
  if (driveMime === DOC) return "text/plain";
  if (driveMime === SHEET) return "text/csv";
  if (driveMime === SLIDES) return "text/plain";
  return null;
}

function pickTool(tools: string[], action: "get-file" | "download-file"): string | null {
  const want = action.replace(/-/g, "");
  for (const t of tools) {
    const norm = t.toLowerCase().replace(/[^a-z]/g, "");
    if (action === "get-file") {
      if (norm.endsWith("getfile") || norm.endsWith("getfilebyid")) return t;
    } else if (norm.endsWith(want)) {
      return t;
    }
  }
  return null;
}

function parseEnvelope(content: string): Record<string, unknown> | null {
  let v: unknown;
  try {
    v = JSON.parse(content);
  } catch {
    return null;
  }
  for (let i = 0; i < 4; i += 1) {
    if (Array.isArray(v)) v = v[0];
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const inner = o.ret ?? o.data ?? o.result ?? o.output;
      if (inner && typeof inner === "object") {
        v = inner;
        continue;
      }
    }
    break;
  }
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const BASE64_RE = /^[A-Za-z0-9+/\s]+={0,2}$/;

function isProbablyText(s: string): boolean {
  if (s.length === 0) return false;
  if (s.includes("\u0000")) return false;
  const sample = s.slice(0, 2048);
  let ctrl = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 9 || (c > 13 && c < 32)) ctrl += 1;
  }
  return ctrl / sample.length < 0.05;
}

export function extractDownloadedText(env: Record<string, unknown>): string | null {
  const candidates: unknown[] = [];
  const push = (o: Record<string, unknown>): void => {
    for (const k of ["content", "fileContent", "file_content", "buffer", "body", "text", "data"]) {
      if (k in o) candidates.push(o[k]);
    }
  };
  push(env);
  for (const k of ["files", "downloads", "results"]) {
    const arr = env[k];
    if (Array.isArray(arr) && arr[0] && typeof arr[0] === "object") {
      push(arr[0] as Record<string, unknown>);
    }
  }

  for (const c of candidates) {
    if (c && typeof c === "object" && (c as { type?: string }).type === "Buffer") {
      const data = (c as { data?: unknown }).data;
      if (Array.isArray(data)) {
        const text = Buffer.from(data as number[]).toString("utf8");
        if (isProbablyText(text)) return text;
      }
      continue;
    }
    const s = str(c);
    if (!s) continue;
    const compact = s.replace(/\s/g, "");
    const looksBase64 = BASE64_RE.test(s) && compact.length % 4 === 0;
    if (isProbablyText(s) && !looksBase64) return s;
    if (looksBase64) {
      try {
        const text = Buffer.from(compact, "base64").toString("utf8");
        if (isProbablyText(text)) return text;
      } catch {
      }
    }
  }
  return null;
}

function accessRequiredMessage(file_id: string): string {
  return (
    `Zavi can't open this Google file (id ${file_id}) — the connected Google account doesn't have access. ` +
    `Most likely causes, in order: ` +
    `(1) ask the doc owner to share it with the Google account connected in Settings, Connectors, Google Drive (Viewer is enough), then re-send the link; ` +
    `(2) reconnect Google Drive with an account that can open this doc; ` +
    `(3) the link is wrong or the file was deleted. Relay the matching instruction to the user.`
  );
}

export async function readGoogleFileViaPipedream(
  ref: GoogleFileRef,
  tools: string[],
  call: PipedreamToolCaller,
): Promise<GoogleReadResult> {
  const fail = (
    status: "access_required" | "unsupported" | "error",
    message: string,
  ): GoogleReadResult => ({ status, file_id: ref.file_id, message });

  const getTool = pickTool(tools, "get-file");
  const dlTool = pickTool(tools, "download-file");
  if (!dlTool) {
    return fail(
      "error",
      "The connected Google Drive account didn't advertise a file-download tool, so Zavi can't read the file. Ask the user to reconnect Google Drive in Settings, Connectors.",
    );
  }

  let name = "Google file";
  let driveMime = DOC;
  if (getTool) {
    const metaRes = await call(getTool, {
      fileId: ref.file_id,
      fields: "id,name,mimeType,trashed",
    });
    const env = metaRes.is_error ? null : parseEnvelope(metaRes.content);
    if (!env) {
      return fail("access_required", accessRequiredMessage(ref.file_id));
    }
    name = str(env.name) ?? name;
    driveMime = str(env.mimeType) ?? driveMime;
    if (env.trashed === true) {
      return fail("access_required", accessRequiredMessage(ref.file_id));
    }
  }

  if (driveMime === FOLDER) {
    return fail(
      "unsupported",
      "That's a Drive folder link. Folder listing isn't supported — ask the user to paste a link to a specific doc/sheet.",
    );
  }

  const exportMime = exportMimeFor(driveMime);
  const isWorkspaceFile = driveMime.startsWith("application/vnd.google-apps.");
  if (!isWorkspaceFile && !/^(text\/|application\/json)/.test(driveMime)) {
    return fail(
      "unsupported",
      `This Drive file is ${driveMime} — Zavi reads Google Docs, Sheets, Slides, and plain-text files. Ask the user to paste the content or export it as a Google Doc.`,
    );
  }
  if (isWorkspaceFile && exportMime === null) {
    return fail(
      "unsupported",
      `This Drive file is ${driveMime} — Zavi reads Google Docs, Sheets, Slides, and plain-text files. Ask the user to paste the content or export it as a Google Doc.`,
    );
  }

  const dlRes = await call(dlTool, {
    fileId: ref.file_id,
    getBufferResponse: true,
    ...(exportMime ? { mimeType: exportMime } : {}),
  });
  if (dlRes.is_error) {
    return fail("access_required", accessRequiredMessage(ref.file_id));
  }
  const env = parseEnvelope(dlRes.content);
  if (!env) {
    return fail("error", "Google Drive returned an unreadable response for this file.");
  }
  let text = extractDownloadedText(env);
  if (text === null) {
    return fail(
      "error",
      "Google export failed — the file came back in a non-text format. Ask the user to paste the content directly.",
    );
  }
  if (text.length > MAX_BODY_BYTES) text = text.slice(0, MAX_BODY_BYTES);

  const sheetNote =
    driveMime === SHEET
      ? `\n\n_(Read via Drive CSV export: FIRST TAB ONLY${
          ref.gid ? "; the #gid= tab in the link was not honored" : ""
        }. Do not claim to have read other tabs.)_`
      : "";

  return {
    status: "ok",
    file_id: ref.file_id,
    name,
    mime_type: driveMime,
    body_text: wrap(`# ${name}\n\n${text}${sheetNote}`),
  };
}
