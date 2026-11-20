import { describe, it, expect, vi, beforeEach } from "vitest";
const proxy = vi.hoisted(() => vi.fn());
vi.mock("@/services/connectors/composio/api", () => ({ composioProxy: proxy }));
import { publishYouTubeVideoViaComposio } from "../publish";

const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&upload_id=U1";
const acct = { tenant_id: "T1", toolkit: "youtube", connected_account_id: "ca_yt" } as any;
const meta = { title: "T", description: "D", privacy: "unlisted" as const };
const fetchMock = vi.fn();
const video = () => new Response(new Uint8Array([9, 9, 9]), { status: 200 });
const uploaded = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  proxy.mockReset().mockResolvedValue({ ok: true, status: 200, json: {}, location: SESSION });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("publishYouTubeVideoViaComposio", () => {
  it("opens a resumable session through the proxy, then PUTs the raw bytes to it", async () => {
    fetchMock.mockResolvedValueOnce(video()).mockResolvedValueOnce(uploaded({ id: "vid1", status: { uploadStatus: "uploaded" } }));
    const r = await publishYouTubeVideoViaComposio(acct, meta, "https://signed/v.mp4");
    expect(proxy).toHaveBeenCalledWith({
      account: acct, method: "POST",
      endpoint: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      body: { snippet: { title: "T", description: "D", categoryId: "22" }, status: { privacyStatus: "unlisted" } },
      headers: { "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": "3" },
    });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(SESSION);
    expect(init.method).toBe("PUT");
    expect(init.body).toEqual(new Uint8Array([9, 9, 9]));
    expect(init.headers).toEqual({ "Content-Type": "video/mp4" });
    expect(r).toEqual({ ok: true, status: 200, raw: { id: "vid1", url: "https://www.youtube.com/watch?v=vid1", upload_status: "uploaded" } });
  });
  it("a refused session is a vendor rejection and no bytes are sent", async () => {
    fetchMock.mockResolvedValueOnce(video());
    proxy.mockResolvedValue({ ok: false, status: 403, json: { error: { message: "insufficient scope" } } });
    const r = await publishYouTubeVideoViaComposio(acct, meta, "https://signed/v.mp4");
    expect(r).toEqual({ ok: false, status: 400, raw: { error: "YouTube refused the upload session", response: { error: { message: "insufficient scope" } } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("never sends the bytes to a session URI that is not Google's upload endpoint", async () => {
    for (const location of [undefined, "https://evil.example/upload/youtube/v3/videos", "http://www.googleapis.com/upload/youtube/v3/videos"]) {
      fetchMock.mockReset().mockResolvedValueOnce(video());
      proxy.mockResolvedValue({ ok: true, status: 200, json: {}, location });
      const r = await publishYouTubeVideoViaComposio(acct, meta, "https://signed/v.mp4");
      expect(r.ok).toBe(false);
      expect(r.status).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
  it("a failed video download never calls YouTube", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await publishYouTubeVideoViaComposio(acct, meta, "https://s/v.mp4")).toEqual({ ok: false, status: 503, raw: { error: "video fetch 404" } });
    expect(proxy).not.toHaveBeenCalled();
  });
  it("a refused PUT is a vendor rejection; a transport error mid-upload is status 0", async () => {
    fetchMock.mockResolvedValueOnce(video()).mockResolvedValueOnce(uploaded({ error: { message: "bad" } }, 400));
    expect(await publishYouTubeVideoViaComposio(acct, meta, "https://s/v.mp4")).toMatchObject({ ok: false, status: 400 });
    fetchMock.mockResolvedValueOnce(video()).mockRejectedValueOnce(new Error("socket hang up"));
    expect(await publishYouTubeVideoViaComposio(acct, meta, "https://s/v.mp4")).toMatchObject({ ok: false, status: 0 });
  });
  it("a finished upload with no video id is never recorded as published", async () => {
    fetchMock.mockResolvedValueOnce(video()).mockResolvedValueOnce(uploaded({ kind: "youtube#video" }));
    const r = await publishYouTubeVideoViaComposio(acct, meta, "https://s/v.mp4");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});
