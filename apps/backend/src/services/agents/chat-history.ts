
import type {
  ImageBlockParam,
  MessageParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { SupabaseClient } from "@supabase/supabase-js";
import mammoth from "mammoth";
import { isOwnAdImagePath } from "@zavi/shared";

export type ChatRow = {
  sender_role: "user" | "assistant" | "system";
  body: string;
  created_at: string;
  attachments?: Array<{ path: string; kind?: "image" | "doc" }> | null;
};

type ConversationRow = ChatRow & { sender_role: "user" | "assistant" };

const IMG_BUCKET = "agent-chat-images";
const DOC_BUCKET = "agent-chat-docs";
const MAX_ATTACHMENTS_PER_ROW = 8;
const MAX_IMAGES_PER_ROW = 4;
const MAX_DOCS_PER_ROW = 4;
const IMG_REGEX_SUFFIX = /\/[0-9a-f-]{36}\.jpg$/;
const DOC_REGEX_SUFFIX = /\/[0-9a-f-]{36}\.(pdf|txt|docx|csv)$/;

export const ATTACHMENT_ONLY_TEXT = "(attachment)";
export const FILE_TEXT_PREFIX = "[File: ";

export function uploadedImageReferences(tenantId: string, paths: string[]): string {
  const own = paths.filter(path => isOwnAdImagePath(tenantId, path));
  if (own.length === 0) return "";
  return `[Stored photo references, in image order:\n${own.map((path, i) => `${i + 1}: image_path=${path}`).join("\n")}\n` +
    "To reuse a photo in an ad or post, pass its exact image_path to the tool. These are private storage keys, not image_url values. " +
    "Zavi handles provider access; do not ask the user to host these photos or upload them again.]";
}

export function nonEmptyTurnText(text: string): string {
  return text.trim().length > 0 ? text : ATTACHMENT_ONLY_TEXT;
}

type Attachment = { path: string; kind: "image" | "doc" };

function extractAttachments(attachments: unknown): Attachment[] {
  if (!Array.isArray(attachments)) return [];
  const out: Attachment[] = [];
  for (const a of attachments) {
    if (out.length >= MAX_ATTACHMENTS_PER_ROW) break;
    if (a && typeof a === "object" && typeof (a as { path?: unknown }).path === "string") {
      const path = (a as { path: string }).path;
      let kind = (a as { kind?: string }).kind;
      if (kind !== "image" && kind !== "doc") {
        kind = path.endsWith(".jpg") ? "image" : "doc";
      }
      out.push({ path, kind: kind as "image" | "doc" });
    }
  }
  return out;
}

const MAX_EXTRACTED_CHARS = 200_000;

function capText(text: string): string {
  if (text.length <= MAX_EXTRACTED_CHARS) return text;
  return `${text.slice(0, MAX_EXTRACTED_CHARS)}\n[…truncated — document exceeds ${MAX_EXTRACTED_CHARS} characters]`;
}

export function pathBelongsToTenant(path: string, tenantId: string, kind: "image" | "doc"): boolean {
  if (!path.startsWith(`${tenantId}/`)) return false;
  return kind === "image" ? IMG_REGEX_SUFFIX.test(path) : DOC_REGEX_SUFFIX.test(path);
}

export async function downloadAsImageBlock(
  sb: SupabaseClient,
  path: string,
): Promise<ImageBlockParam | null> {
  try {
    const { data: blob, error } = await sb.storage.from(IMG_BUCKET).download(path);
    if (error || !blob) return null;
    const buf = Buffer.from(await blob.arrayBuffer());
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: buf.toString("base64"),
      },
    };
  } catch {
    return null;
  }
}

export type DocumentBlockParam = {
  type: "document";
  source: {
    type: "base64";
    media_type: "application/pdf";
    data: string;
  };
  title?: string;
};

export async function downloadAsDocBlocks(
  sb: SupabaseClient,
  path: string,
): Promise<Array<TextBlockParam | DocumentBlockParam> | null> {
  try {
    const { data: blob, error } = await sb.storage.from(DOC_BUCKET).download(path);
    if (error || !blob) return null;
    const buf = Buffer.from(await blob.arrayBuffer());
    const ext = path.split(".").pop()?.toLowerCase();
    const name = path.split("/").pop();

    if (ext === "pdf") {
      return [{
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: buf.toString("base64"),
        },
        title: name,
      }];
    } else if (ext === "docx") {
      const result = await mammoth.extractRawText({ buffer: buf });
      return [{ type: "text", text: `${FILE_TEXT_PREFIX}${name}]\n${capText(result.value)}` }];
    } else if (ext === "txt" || ext === "csv") {
      return [{ type: "text", text: `${FILE_TEXT_PREFIX}${name}]\n${capText(buf.toString("utf-8"))}` }];
    }
    return null;
  } catch {
    return null;
  }
}

export async function messagesToParams(
  rows: ChatRow[],
  sb: SupabaseClient,
  tenantId: string,
  maxTurns = 40,
  maxPriorImages = 8,
  maxPriorDocs = 4,
): Promise<MessageParam[]> {
  const conv = rows
    .filter(
      (r): r is ConversationRow =>
        r.sender_role === "user" || r.sender_role === "assistant",
    )
    .slice(-maxTurns);

  const reversed = [...conv].reverse();
  const planByIndex: Array<{ row: ConversationRow; attachments: Attachment[] }> = [];
  let imgBudget = maxPriorImages;
  let docBudget = maxPriorDocs;

  for (const row of reversed) {
    if (row.sender_role !== "user" || (imgBudget <= 0 && docBudget <= 0)) {
      planByIndex.push({ row, attachments: [] });
      continue;
    }
    const candidates = extractAttachments(row.attachments);
    const valid: Attachment[] = [];
    let rowImg = 0;
    let rowDoc = 0;
    for (const a of candidates) {
      if (!a.path.startsWith(`${tenantId}/`)) {
        console.warn(`chat-history: tenant-prefix mismatch, skipping ${a.path}`);
        continue;
      }
      if (a.kind === "image") {
        if (imgBudget <= 0 || rowImg >= MAX_IMAGES_PER_ROW) continue;
        if (!IMG_REGEX_SUFFIX.test(a.path)) continue;
        valid.push(a);
        imgBudget--;
        rowImg++;
      } else {
        if (docBudget <= 0 || rowDoc >= MAX_DOCS_PER_ROW) continue;
        if (!DOC_REGEX_SUFFIX.test(a.path)) continue;
        valid.push(a);
        docBudget--;
        rowDoc++;
      }
    }
    planByIndex.push({ row, attachments: valid });
  }

  planByIndex.reverse();

  const out: MessageParam[] = [];
  for (const { row, attachments } of planByIndex) {
    if (attachments.length === 0) {
      out.push({ role: row.sender_role, content: nonEmptyTurnText(row.body) });
      continue;
    }

    const content: any[] = [];
    const loadedImagePaths: string[] = [];
    for (const a of attachments) {
      if (a.kind === "image") {
        const block = await downloadAsImageBlock(sb, a.path);
        if (block) {
          content.push(block);
          loadedImagePaths.push(a.path);
        }
      } else {
        const blocks = await downloadAsDocBlocks(sb, a.path);
        if (blocks) content.push(...blocks);
      }
    }

    if (content.length === 0) {
      console.warn(
        `chat-history: all ${attachments.length} attachment(s) failed for a ${row.sender_role} row; falling back to text-only`,
      );
      out.push({ role: row.sender_role, content: nonEmptyTurnText(row.body) });
    } else {
      const references = uploadedImageReferences(tenantId, loadedImagePaths);
      const text = [row.body, references].filter(part => part.trim().length > 0).join("\n\n");
      if (text) content.push({ type: "text", text });
      out.push({ role: row.sender_role, content } as MessageParam);
    }
  }
  return out;
}
