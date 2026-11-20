
import { proxyRequest } from "@/services/connectors/pipedream/api";
import type { YouTubePrivacy } from "@/services/connectors/youtube-composio/constants";

export const YT_PIPEDREAM_APP = "youtube_data_api";
const INIT_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
export const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_CHUNKS = 64;

export type YtPipedreamResult = { ok: boolean; status: number; raw: Record<string, unknown> };

export async function publishYouTubeVideoViaPipedream(
  tenantId: string,
  accountId: string,
  meta: { title: string; description: string; privacy: YouTubePrivacy },
  videoUrl: string,
): Promise<YtPipedreamResult> {
  const ctx = { external_user_id: tenantId, app_slug: YT_PIPEDREAM_APP, account_id: accountId };

  const v = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
  if (!v.ok) return { ok: false, status: 400, raw: { error: `video fetch ${v.status}` } };
  const bytes = Buffer.from(await v.arrayBuffer());
  if (Math.ceil(bytes.length / CHUNK_BYTES) > MAX_CHUNKS) {
    return { ok: false, status: 400, raw: { error: `video too large for the proxied upload (${bytes.length} bytes)` } };
  }

  const init = await proxyRequest({
    ...ctx,
    method: "POST",
    url: INIT_URL,
    body: {
      snippet: { title: meta.title.slice(0, 100), description: meta.description.slice(0, 5000) },
      status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false },
    },
    upstreamHeaders: { "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(bytes.length) },
  });
  if (!init.ok) {
    const reason = ((init.json.error as { errors?: Array<{ reason?: string }> } | undefined)?.errors ?? [])[0]?.reason;
    if (reason === "youtubeSignupRequired") {
      return {
        ok: false,
        status: 400,
        raw: { ...init.json, error: "the connected Google account owns no YouTube channel — create one at youtube.com/account, then reconnect" },
      };
    }
    return { ok: false, status: init.status, raw: init.json };
  }
  const location = init.headers["location"] ?? "";
  if (!location) {
    return { ok: false, status: 502, raw: { error: "youtube upload session: proxy relayed no Location header", init_headers: Object.keys(init.headers) } };
  }

  let offset = 0;
  let last: Awaited<ReturnType<typeof proxyRequest>> | null = null;
  for (let i = 0; i < MAX_CHUNKS && offset < bytes.length; i++) {
    const end = Math.min(offset + CHUNK_BYTES, bytes.length);
    const chunk = bytes.subarray(offset, end);
    last = await proxyRequest({
      ...ctx,
      method: "PUT",
      url: location,
      rawBody: chunk,
      contentType: "video/mp4",
      upstreamHeaders: { "Content-Range": `bytes ${offset}-${end - 1}/${bytes.length}` },
      timeoutMs: 29_000,
    });
    if (last.status === 308) {
      const m = /bytes=0-(\d+)/.exec(last.headers["range"] ?? "");
      offset = m ? Number(m[1]) + 1 : end;
      continue;
    }
    if (!last.ok) return { ok: false, status: last.status, raw: { ...last.json, offset } };
    offset = bytes.length;
  }
  if (!last || !last.ok) return { ok: false, status: last?.status ?? 502, raw: { error: "youtube upload did not complete", offset } };

  const id = typeof last.json.id === "string" ? last.json.id : "";
  const status = (last.json.status as { privacyStatus?: string } | undefined)?.privacyStatus;
  return {
    ok: true,
    status: last.status,
    raw: {
      ...last.json,
      id,
      transport: "pipedream",
      ...(id ? { url: `https://www.youtube.com/watch?v=${id}` } : {}),
      ...(status ? { privacy_applied: status, privacy_requested: meta.privacy } : {}),
    },
  };
}
