
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Writable } from "node:stream";

const { requireAuthMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(async () => ({ user_id: "biz-user", tenant_id: "tenant-A", access_token: "tok" }) as unknown),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: requireAuthMock }));

import { serveCreatorIntroVideo } from "../creator-hub";
import { introVideoMime, streamIntroVideo, type IntroVideoDeps } from "@/services/creators/intro-video";

const OWNER = "11111111-1111-1111-1111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const PATH = `${OWNER}/aaaaaaaa-0000-0000-0000-000000000000.mp4`;
const SIGNED = `https://proj.supabase.co/storage/v1/object/sign/creator-media/${PATH}?token=abc`;

function mockRes() {
  const chunks: Buffer[] = [];
  const out = { code: 200, body: null as unknown, headers: {} as Record<string, string>, bytes: () => Buffer.concat(chunks) };
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => (done = r));
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
    final(cb) {
      done();
      cb();
    },
  }) as Writable & Record<string, unknown>;
  res.status = (c: number) => ((out.code = c), res);
  res.json = (b: unknown) => ((out.body = b), done(), res);
  res.setHeader = (k: string, v: string) => ((out.headers[k.toLowerCase()] = v), res);
  return { res: res as never, out, finished };
}

function videoDeps(over: Partial<IntroVideoDeps> = {}): IntroVideoDeps & { sign: ReturnType<typeof vi.fn> } {
  return {
    sign: vi.fn(async () => SIGNED),
    fetch: vi.fn(async () => new Response("VIDEO-BYTES", { status: 200, headers: { "content-length": "11" } })),
    ...over,
  } as never;
}

const member = (over: Record<string, unknown> = {}) => ({
  id: MEMBER,
  slug: "maya",
  display_name: "Maya",
  city: null,
  country_code: "US",
  bio: null,
  lanes: [],
  skills: [],
  intro_video_path: PATH,
  auth_user_id: OWNER,
  vetting_state: "approved",
  ...over,
});

beforeEach(() => {
  requireAuthMock.mockClear();
});

describe("GET /api/humans/creators/:memberId/intro-video", () => {
  it("streams the video with a video type and private caching", async () => {
    const { res, out, finished } = mockRes();
    const video = videoDeps();
    await serveCreatorIntroVideo({ params: { memberId: MEMBER } } as never, res, { loadMember: async () => member() as never }, video);
    await finished;
    expect(out.code).toBe(200);
    expect(out.headers["content-type"]).toBe("video/mp4");
    expect(out.headers["cache-control"]).toBe("private, no-store");
    expect(out.bytes().toString()).toBe("VIDEO-BYTES");
  });

  it("never puts the storage path, the auth user id or the signed URL in a header", async () => {
    const { res, out, finished } = mockRes();
    await serveCreatorIntroVideo({ params: { memberId: MEMBER } } as never, res, { loadMember: async () => member() as never }, videoDeps());
    await finished;
    const said = JSON.stringify(out.headers);
    expect(said).not.toContain(OWNER);
    expect(said).not.toContain("supabase");
  });

  it("does nothing when sign-in has already answered", async () => {
    requireAuthMock.mockResolvedValueOnce(null);
    const load = vi.fn();
    const { res } = mockRes();
    await serveCreatorIntroVideo({ params: { memberId: MEMBER } } as never, res, { loadMember: load }, videoDeps());
    expect(load).not.toHaveBeenCalled();
  });

  it("404s a creator who is not approved, with no read of storage", async () => {
    const video = videoDeps();
    const { res, out } = mockRes();
    await serveCreatorIntroVideo({ params: { memberId: MEMBER } } as never, res, { loadMember: async () => member({ vetting_state: "pending" }) as never }, video);
    expect(out.code).toBe(404);
    expect(video.sign).not.toHaveBeenCalled();
  });

  it("404s a creator with no intro video, and a bad member id", async () => {
    const a = mockRes();
    await serveCreatorIntroVideo({ params: { memberId: MEMBER } } as never, a.res, { loadMember: async () => member({ intro_video_path: null }) as never }, videoDeps());
    expect(a.out.code).toBe(404);
    const b = mockRes();
    await serveCreatorIntroVideo({ params: { memberId: "not-a-uuid" } } as never, b.res, { loadMember: async () => member() as never }, videoDeps());
    expect(b.out.code).toBe(404);
  });

  it("refuses a path that is not under the owner's own prefix", async () => {
    const video = videoDeps();
    const { res, out } = mockRes();
    await serveCreatorIntroVideo(
      { params: { memberId: MEMBER } } as never,
      res,
      { loadMember: async () => member({ intro_video_path: "33333333-3333-3333-3333-333333333333/x.mp4" }) as never },
      video,
    );
    expect(out.code).toBe(404);
    expect(video.sign).not.toHaveBeenCalled();
  });
});

describe("streamIntroVideo failures", () => {
  it("says 404 when the stored object is gone, 503 when storage does not answer", async () => {
    const gone = mockRes();
    await streamIntroVideo(gone.res, PATH, OWNER, videoDeps({ fetch: async () => new Response("", { status: 404 }) }));
    expect(gone.out.code).toBe(404);
    const down = mockRes();
    await streamIntroVideo(down.res, PATH, OWNER, videoDeps({ fetch: async () => { throw new Error("network"); } }));
    expect(down.out.code).toBe(503);
    expect(JSON.stringify(down.out.body)).not.toContain(OWNER);
  });

  it("cancels the storage read when the viewer leaves mid-video", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode("chunk"));
        return new Promise((r) => setTimeout(r, 5));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { res } = mockRes();
    await streamIntroVideo(res, PATH, OWNER, videoDeps({ fetch: async () => new Response(upstream, { status: 200 }) }));
    await new Promise((r) => setTimeout(r, 20));
    (res as unknown as { destroy: () => void }).destroy();
    await new Promise((r) => setTimeout(r, 40));
    expect(cancelled).toBe(true);
  });

  it("drops the storage read when the viewer left before it answered", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel() {
        cancelled = true;
      },
    });
    const { res } = mockRes();
    (res as unknown as { destroy: () => void }).destroy();
    await streamIntroVideo(res, PATH, OWNER, videoDeps({ fetch: async () => new Response(upstream, { status: 200 }) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelled).toBe(true);
  });

  it("names the video type from the key", () => {
    expect(introVideoMime(`${OWNER}/a.mov`)).toBe("video/quicktime");
    expect(introVideoMime(`${OWNER}/a.webm`)).toBe("video/webm");
    expect(introVideoMime(`${OWNER}/a`)).toBe("video/mp4");
  });
});
