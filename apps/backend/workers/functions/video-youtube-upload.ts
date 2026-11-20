
import { randomUUID } from "node:crypto";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { validateChannelPayload } from "@/services/connectors/social-channels";
import { SOCIAL_LIMITS } from "@zavi/shared";

const SOURCE_BUCKET = "launch-video-artifacts";
const MEDIA_BUCKET = "launch-video-media";
const MAX_BYTES = 50 * 1024 * 1024;
export const SOCIAL_PUBLISH_CLASS = "social.publish.v2";

type Res<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;
export type UploadSb = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  storage: {
    from: (bucket: string) => {
      download: (path: string) => Res<Blob>;
      upload: (path: string, body: Buffer, opts: { contentType: string; upsert: boolean }) => Res<unknown>;
    };
  };
};

type CardRow = {
  channel_slug: string;
  title: string | null;
  exec_payload: { post?: { title?: unknown; description?: unknown } } | null;
};

export type StageResult =
  | { staged: true; decision_id: string }
  | { staged: false; reason: "not_youtube" | "already_staged" | "too_large" | "no_card" };

export function uploadText(card: CardRow): { title: string; text: string } {
  const post = card.exec_payload?.post ?? {};
  const rawTitle = typeof post.title === "string" && post.title.trim() ? post.title : (card.title ?? "").replace(/^[^:]{1,40}:\s*/, "");
  const title = (rawTitle.trim() || "New video").slice(0, SOCIAL_LIMITS.youtube_video.title);
  const desc = typeof post.description === "string" ? post.description.trim() : "";
  const text = (desc || title).slice(0, SOCIAL_LIMITS.youtube_video.text);
  return { title, text };
}

export async function stageYouTubeUploadForCard(
  sb: UploadSb,
  args: { tenant_id: string; action_id: string; video_path: string },
  rpc: typeof tenantRpc = tenantRpc,
): Promise<StageResult> {
  const { tenant_id, action_id, video_path } = args;
  const card = await sb
    .from("channel_actions")
    .select("channel_slug, title, exec_payload")
    .eq("id", action_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (card.error) throw new Error(`card read failed: ${card.error.message}`);
  const row = card.data as CardRow | null;
  if (!row) return { staged: false, reason: "no_card" };
  if (row.channel_slug !== "youtube_organic") return { staged: false, reason: "not_youtube" };

  const existing = await sb
    .from("decisions")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("decision_class", SOCIAL_PUBLISH_CLASS)
    .eq("body->>source_action_id", action_id)
    .limit(1);
  if (existing.error) throw new Error(`upload card dedupe read failed: ${existing.error.message}`);
  if ((existing.data ?? []).length > 0) return { staged: false, reason: "already_staged" };

  const file = await sb.storage.from(SOURCE_BUCKET).download(video_path);
  if (file.error || !file.data) throw new Error(`video read failed: ${file.error?.message ?? "empty"}`);
  const bytes = Buffer.from(await file.data.arrayBuffer());
  if (bytes.length > MAX_BYTES) return { staged: false, reason: "too_large" };
  const mediaPath = `${tenant_id}/${randomUUID()}.mp4`;
  const up = await sb.storage.from(MEDIA_BUCKET).upload(mediaPath, bytes, { contentType: "video/mp4", upsert: false });
  if (up.error) throw new Error(`video copy failed: ${up.error.message}`);

  const payload = validateChannelPayload("youtube_video", { ...uploadText(row), video_path: mediaPath, privacy: "public" });
  const { data, error } = await rpc(asTenantId(tenant_id), "emit_decision", {
    p_agent_run_id: null,
    p_decision_class: SOCIAL_PUBLISH_CLASS,
    p_body: { channel: "youtube_video", payload, scheduled_at: null, origin: "generated_video_card", source_action_id: action_id },
  });
  if (error) throw new Error(`emit_decision failed: ${error.message}`);
  return { staged: true, decision_id: String(data) };
}
