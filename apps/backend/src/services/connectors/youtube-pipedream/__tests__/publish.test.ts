
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ proxyRequest: vi.fn() }));
vi.mock("@/services/connectors/pipedream/api", () => ({ proxyRequest: m.proxyRequest, listConnectedAccounts: vi.fn() }));

import { publishYouTubeVideoViaPipedream, CHUNK_BYTES } from "../publish";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const META = { title: "T", description: "D", privacy: "public" as const };
const call = (i: number) => m.proxyRequest.mock.calls[i][0] as Record<string, unknown>;

function mockVideo(bytes: number) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(bytes) })));
}

beforeEach(() => m.proxyRequest.mockReset());

describe("publishYouTubeVideoViaPipedream", () => {
  it("opens the session then PUTs one chunk for a small file", async () => {
    mockVideo(1024);
    m.proxyRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: {}, headers: { location: "https://upload.example/s1" } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { id: "vid1", status: { privacyStatus: "public" } }, headers: {} });
    const r = await publishYouTubeVideoViaPipedream(TENANT, "apn_1", META, "https://signed.example/v.mp4");
    expect(r.ok).toBe(true);
    expect(r.raw).toMatchObject({ id: "vid1", url: "https://www.youtube.com/watch?v=vid1", transport: "pipedream", privacy_applied: "public", privacy_requested: "public" });

    const init = call(0);
    expect(init).toMatchObject({ method: "POST", app_slug: "youtube_data_api", account_id: "apn_1", external_user_id: TENANT });
    expect(String(init.url)).toContain("uploadType=resumable");
    expect(init.upstreamHeaders).toMatchObject({ "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": "1024" });
    const put = call(1);
    expect(put).toMatchObject({ method: "PUT", url: "https://upload.example/s1", contentType: "video/mp4" });
    expect((put.upstreamHeaders as Record<string, string>)["Content-Range"]).toBe("bytes 0-1023/1024");
    expect((put.rawBody as Buffer).length).toBe(1024);
  });

  it("chunks a large file and resumes from the 308 Range header", async () => {
    const size = CHUNK_BYTES + 100;
    mockVideo(size);
    m.proxyRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: {}, headers: { location: "https://upload.example/s2" } })
      .mockResolvedValueOnce({ ok: false, status: 308, json: {}, headers: { range: `bytes=0-${CHUNK_BYTES - 1}` } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { id: "vid2" }, headers: {} });
    const r = await publishYouTubeVideoViaPipedream(TENANT, "apn_1", META, "https://s/v.mp4");
    expect(r.ok).toBe(true);
    expect(m.proxyRequest).toHaveBeenCalledTimes(3);
    expect((call(1).upstreamHeaders as Record<string, string>)["Content-Range"]).toBe(`bytes 0-${CHUNK_BYTES - 1}/${size}`);
    expect((call(2).upstreamHeaders as Record<string, string>)["Content-Range"]).toBe(`bytes ${CHUNK_BYTES}-${size - 1}/${size}`);
    expect((call(2).rawBody as Buffer).length).toBe(100);
  });

  it("fails loud when the proxy relays no Location header", async () => {
    mockVideo(10);
    m.proxyRequest.mockResolvedValueOnce({ ok: true, status: 200, json: {}, headers: { "content-type": "application/json" } });
    const r = await publishYouTubeVideoViaPipedream(TENANT, "apn_1", META, "https://s/v.mp4");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(String((r.raw as { error: string }).error)).toMatch(/no Location header/);
  });

  it("names youtubeSignupRequired as 'no YouTube channel' rather than a bare 401", async () => {
    mockVideo(10);
    m.proxyRequest.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: { error: { code: 401, errors: [{ reason: "youtubeSignupRequired" }] } },
      headers: {},
    });
    const r = await publishYouTubeVideoViaPipedream(TENANT, "apn_1", META, "https://s/v.mp4");
    expect(r.ok).toBe(false);
    expect(String((r.raw as { error: string }).error)).toMatch(/owns no YouTube channel/);
  });

  it("reports the vendor status on a refused session, and never throws", async () => {
    mockVideo(10);
    m.proxyRequest.mockResolvedValueOnce({ ok: false, status: 403, json: { error: { message: "quota" } }, headers: {} });
    const r = await publishYouTubeVideoViaPipedream(TENANT, "apn_1", META, "https://s/v.mp4");
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("surfaces a forced-private upload rather than reporting the requested privacy", async () => {
    mockVideo(10);
    m.proxyRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: {}, headers: { location: "https://upload.example/s3" } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { id: "v3", status: { privacyStatus: "private" } }, headers: {} });
    const r = await publishYouTubeVideoViaPipedream(TENANT, "apn_1", META, "https://s/v.mp4");
    expect(r.raw).toMatchObject({ privacy_requested: "public", privacy_applied: "private" });
  });
});
