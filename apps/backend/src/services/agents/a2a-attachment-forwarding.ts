
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { serviceClient } from "@/services/supabase";
import {
  downloadAsImageBlock,
  downloadAsDocBlocks,
  pathBelongsToTenant,
} from "@/services/agents/chat-history";
import { normalizeSlackImageRefs, type SlackImageRef } from "@/services/agents/slack-inbound-image";

type Sb = ReturnType<typeof serviceClient>;

export type AttachmentRef = { path: string; kind: "image" | "doc" };

const MAX_FWD_IMAGES = 4;
const MAX_FWD_DOCS = 4;

export async function isA2aAttachmentForwardingEnabled(sb?: Sb): Promise<boolean> {
  try {
    const client = sb ?? serviceClient();
    const { data, error } = await client
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.a2a_attachment_forwarding === true;
  } catch {
    return false;
  }
}

export function isExactTenantPath(
  path: string,
  tenantId: string,
  kind: "image" | "doc",
): boolean {
  if (typeof path !== "string") return false;
  if (path.split("/").length !== 2) return false;
  return pathBelongsToTenant(path, tenantId, kind);
}

export function extractParentAttachmentRefs(
  parentPayload: unknown,
  tenantId: string,
): AttachmentRef[] {
  if (!parentPayload || typeof parentPayload !== "object") return [];
  const p = parentPayload as { image_paths?: unknown; doc_paths?: unknown };
  const out: AttachmentRef[] = [];

  const imagePaths = Array.isArray(p.image_paths) ? p.image_paths : [];
  let imgCount = 0;
  for (const raw of imagePaths) {
    if (imgCount >= MAX_FWD_IMAGES) break;
    if (typeof raw === "string" && isExactTenantPath(raw, tenantId, "image")) {
      out.push({ path: raw, kind: "image" });
      imgCount++;
    }
  }

  const docPaths = Array.isArray(p.doc_paths) ? p.doc_paths : [];
  let docCount = 0;
  for (const raw of docPaths) {
    if (docCount >= MAX_FWD_DOCS) break;
    if (typeof raw === "string" && isExactTenantPath(raw, tenantId, "doc")) {
      out.push({ path: raw, kind: "doc" });
      docCount++;
    }
  }

  return out;
}

export const LOOKBACK_WINDOW_MS = 40 * 60 * 1000;

export const LOOKBACK_WINDOW_MINUTES = Math.round(LOOKBACK_WINDOW_MS / 60_000);

export const EXPIRED_UPLOAD_NOTE =
  `[Note from Zavi's system, not the user: the user attached a file earlier in this conversation, ` +
  `but uploads are only available to specialist runs for ${LOOKBACK_WINDOW_MINUTES} minutes and that window has passed. ` +
  `The file is NOT available to you — do not try temp paths, local files, or URLs. ` +
  `Only if this request needs that file: tell the user, in one line, to re-attach it and send the request again ` +
  `(uploads stay available for ${LOOKBACK_WINDOW_MINUTES} minutes), and say nothing more about why. ` +
  `If the request does not need the file, ignore this note and do the request.]`;

export const FORWARDING_OFF_NOTE =
  `[Note from Zavi's system, not the user: the user attached a file with this request, ` +
  `but file forwarding to specialist runs is not enabled, so the file is NOT available to you — ` +
  `do not try temp paths, local files, or URLs. Do every part of the request that does not need the file. ` +
  `Only if a step needs it: say, in one line, that you could not access the attached file for that step, and say nothing more about why.]`;

export function parentTurnHadAttachment(parentPayload: unknown, tenantId: string): boolean {
  return (
    extractParentAttachmentRefs(parentPayload, tenantId).length > 0 ||
    extractParentSlackImageRefs(parentPayload).length > 0 ||
    extractParentVideoPaths(parentPayload, tenantId).length > 0
  );
}

export async function lookbackThreadAttachmentRefs(
  sb: Sb,
  tenantId: string,
  parentPayload: unknown,
): Promise<AttachmentRef[]> {
  return (await lookbackThreadAttachmentsWithExpiry(sb, tenantId, parentPayload)).refs;
}

export async function lookbackThreadAttachmentsWithExpiry(
  sb: Sb,
  tenantId: string,
  parentPayload: unknown,
): Promise<{ refs: AttachmentRef[]; expiredUpload: boolean }> {
  const none = { refs: [] as AttachmentRef[], expiredUpload: false };
  try {
    const threadId =
      parentPayload && typeof parentPayload === "object"
        ? (parentPayload as { thread_id?: unknown }).thread_id
        : null;
    if (typeof threadId !== "string" || threadId.length === 0) return none;
    if (extractParentVideoPaths(parentPayload, tenantId).length > 0) return none;
    const latest = (withWindow: boolean) => {
      let q = sb
        .from("agent_thread_messages")
        .select("attachments")
        .eq("thread_id", threadId)
        .eq("tenant_id", tenantId)
        .eq("sender_role", "user")
        .not("attachments", "is", null);
      if (withWindow) {
        q = q.gte("created_at", new Date(Date.now() - LOOKBACK_WINDOW_MS).toISOString());
      }
      return q
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ attachments: unknown }>();
    };
    const { data, error } = await latest(true);
    if (error) return none;
    if (data) {
      const refs = normalizeChildAttachmentRefs(data.attachments, tenantId);
      if (refs.length > 0) return { refs, expiredUpload: false };
    }
    const older = await latest(false);
    const expiredUpload =
      !older.error &&
      !!older.data &&
      normalizeChildAttachmentRefs(older.data.attachments, tenantId).length > 0;
    return { refs: [], expiredUpload };
  } catch {
    return none;
  }
}

export function extractParentSlackImageRefs(parentPayload: unknown): SlackImageRef[] {
  if (!parentPayload || typeof parentPayload !== "object") return [];
  const slack = (parentPayload as { slack?: unknown }).slack;
  if (!slack || typeof slack !== "object") return [];
  return normalizeSlackImageRefs((slack as { images?: unknown }).images);
}

export function normalizeChildAttachmentRefs(
  attachmentPaths: unknown,
  tenantId: string,
): AttachmentRef[] {
  if (!Array.isArray(attachmentPaths)) return [];
  const out: AttachmentRef[] = [];
  let imgCount = 0;
  let docCount = 0;
  for (const a of attachmentPaths) {
    if (!a || typeof a !== "object") continue;
    const path = (a as { path?: unknown }).path;
    const kind = (a as { kind?: unknown }).kind;
    if (typeof path !== "string") continue;
    if (kind !== "image" && kind !== "doc") continue;
    if (!isExactTenantPath(path, tenantId, kind)) continue;
    if (kind === "image") {
      if (imgCount >= MAX_FWD_IMAGES) continue;
      imgCount++;
    } else {
      if (docCount >= MAX_FWD_DOCS) continue;
      docCount++;
    }
    out.push({ path, kind });
  }
  return out;
}

export async function resolveForwardedContent(
  sb: Sb,
  tenantId: string,
  refs: AttachmentRef[],
  intentText: string,
): Promise<MessageParam["content"] | null> {
  if (!refs || refs.length === 0) return null;

  const imageBlocks: any[] = [];
  const docBlocks: any[] = [];
  const failureMarkers: Array<{ type: "text"; text: string }> = [];

  for (const ref of refs) {
    if (!isExactTenantPath(ref.path, tenantId, ref.kind)) {
      console.warn(
        `[a2a-attachment-forwarding] dropping non-tenant path on child resolve (tenant=${tenantId})`,
      );
      continue;
    }
    const name = ref.path.split("/").pop() ?? "attachment";
    try {
      if (ref.kind === "image") {
        const block = await downloadAsImageBlock(sb, ref.path);
        if (block) {
          imageBlocks.push(block);
          imageBlocks.push({
            type: "text" as const,
            text: `[the image above is stored at agent-chat-images path ${ref.path} — pass that exact value as image_path when staging a post with it]`,
          });
        }
        else failureMarkers.push({ type: "text", text: `[forwarded image ${name} could not be loaded]` });
      } else {
        const blocks = await downloadAsDocBlocks(sb, ref.path);
        if (blocks && blocks.length > 0) docBlocks.push(...blocks);
        else failureMarkers.push({ type: "text", text: `[forwarded file ${name} could not be loaded]` });
      }
    } catch (e) {
      console.warn(
        `[a2a-attachment-forwarding] download failed for a forwarded attachment: ${(e as Error).message}`,
      );
      failureMarkers.push({ type: "text", text: `[forwarded file ${name} could not be loaded]` });
    }
  }

  const content = [
    ...imageBlocks,
    ...docBlocks,
    ...failureMarkers,
    { type: "text" as const, text: intentText },
  ];
  return content as MessageParam["content"];
}

export async function resolveTopActionImages(
  sb: Sb,
  tenantId: string,
  paths: readonly string[],
  intentText: string,
): Promise<MessageParam["content"] | null> {
  const refs = normalizeChildAttachmentRefs(
    paths.map((path) => ({ path, kind: "image" })),
    tenantId,
  );
  if (refs.length === 0) return null;
  return resolveForwardedContent(sb, tenantId, refs, intentText);
}

const MAX_FWD_VIDEOS = 1;
const VIDEO_KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4$/;

export function extractParentVideoPaths(
  parentPayload: unknown,
  tenantId: string,
): string[] {
  if (!parentPayload || typeof parentPayload !== "object") return [];
  const raw = (parentPayload as { video_paths?: unknown }).video_paths;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (out.length >= MAX_FWD_VIDEOS) break;
    if (typeof v !== "string") continue;
    if (!v.startsWith(`${tenantId}/`)) continue;
    if (v.split("/").length !== 2) continue;
    if (!VIDEO_KEY_RE.test(v)) continue;
    out.push(v);
  }
  return out;
}
