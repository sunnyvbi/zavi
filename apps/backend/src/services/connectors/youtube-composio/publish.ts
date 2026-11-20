import { composioProxy, type OwnedComposioAccount } from "@/services/connectors/composio/api";
import type { YouTubePrivacy } from "./constants";

const INIT_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

type Result = { ok: boolean; status: number; raw: Record<string, unknown> };

function isSessionUri(loc: string): boolean {
  try {
    const u = new URL(loc);
    return u.protocol === "https:" && u.hostname === "www.googleapis.com" && u.pathname.startsWith("/upload/youtube/v3/videos");
  } catch {
    return false;
  }
}

export async function publishYouTubeVideoViaComposio(
  account: OwnedComposioAccount,
  meta: { title: string; description: string; privacy: YouTubePrivacy },
  videoUrl: string,
): Promise<Result> {
  let bytes: Uint8Array;
  try {
    const v = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
    if (!v.ok) return { ok: false, status: 503, raw: { error: `video fetch ${v.status}` } };
    bytes = new Uint8Array(await v.arrayBuffer());
  } catch (e) {
    return { ok: false, status: 503, raw: { error: `video fetch failed: ${(e as Error).message}` } };
  }

  const init = await composioProxy({
    account,
    method: "POST",
    endpoint: INIT_URL,
    body: {
      snippet: { title: meta.title, description: meta.description, categoryId: "22" },
      status: { privacyStatus: meta.privacy },
    },
    headers: { "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(bytes.byteLength) },
  });
  if (!init.ok) {
    return { ok: false, status: init.status >= 500 || init.status === 0 ? init.status : 400, raw: { error: "YouTube refused the upload session", response: init.json } };
  }
  if (!init.location || !isSessionUri(init.location)) {
    return { ok: false, status: 503, raw: { error: "YouTube returned no upload session URI", response: init.json } };
  }

  let res: Response;
  try {
    res = await fetch(init.location, {
      method: "PUT", body: bytes, headers: { "Content-Type": "video/mp4" }, redirect: "error", signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    return { ok: false, status: 0, raw: { error: `video upload failed: ${(e as Error).message}` } };
  }
  const d = ((await res.json().catch(() => null)) ?? {}) as { id?: unknown; status?: { uploadStatus?: unknown } };
  if (!res.ok) return { ok: false, status: res.status >= 500 ? res.status : 400, raw: { error: `YouTube upload ${res.status}`, response: d } };
  const id = typeof d.id === "string" ? d.id : "";
  if (!id) {
    return { ok: false, status: 400, raw: { error: "YouTube returned no video id; check the channel before staging this upload again", response: d } };
  }
  return { ok: true, status: 200, raw: { id, url: `https://www.youtube.com/watch?v=${id}`, upload_status: d.status?.uploadStatus ?? null } };
}
