
import { describe, it, expect, vi } from "vitest";
import { stageYouTubeUploadForCard, uploadText, SOCIAL_PUBLISH_CLASS, type UploadSb } from "../video-youtube-upload";

const TENANT = "2270dacb-776f-43d7-97ea-91eed114e915";
const ACTION = "b95ce88e-a695-42da-bd1f-43fa5c4a27a0";
const VIDEO = `${TENANT}/run-1/video.mp4`;

function fakeSb(opts: { card: unknown; existing?: unknown[]; bytes?: number }) {
  const uploads: Array<{ bucket: string; path: string; contentType: string }> = [];
  const downloads: Array<{ bucket: string; path: string }> = [];
  const eqs: Array<[string, string, unknown]> = [];
  const chain = (table: string, result: unknown) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: string, v: unknown) => {
      eqs.push([table, col, v]);
      return b;
    };
    b.maybeSingle = async () => ({ data: result, error: null });
    b.limit = async () => ({ data: result, error: null });
    return b;
  };
  const sb: UploadSb = {
    from: (table: string) => chain(table, table === "channel_actions" ? opts.card : (opts.existing ?? [])),
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          downloads.push({ bucket, path });
          return { data: new Blob([new Uint8Array(opts.bytes ?? 1024)]), error: null };
        },
        upload: async (path: string, _b: Buffer, o: { contentType: string }) => {
          uploads.push({ bucket, path, contentType: o.contentType });
          return { data: {}, error: null };
        },
      }),
    },
  };
  return { sb, uploads, downloads, eqs };
}

const YT_CARD = {
  channel_slug: "youtube_organic",
  title: "Offer: Up to 52% off Zoomcar, until 5 October.",
  exec_payload: { post: { title: "Up to 52% off Zoomcar, until 5 October.", description: "Use code EOSS52 on zoomcar.in." } },
};

describe("stageYouTubeUploadForCard", () => {
  it("copies the video to launch-video-media and stages a never-auto YouTube upload approval", async () => {
    const { sb, uploads, downloads, eqs } = fakeSb({ card: YT_CARD });
    const rpc = vi.fn(async () => ({ data: "dec-1", error: null }));

    const out = await stageYouTubeUploadForCard(sb, { tenant_id: TENANT, action_id: ACTION, video_path: VIDEO }, rpc as never);

    expect(out).toEqual({ staged: true, decision_id: "dec-1" });
    expect(downloads).toEqual([{ bucket: "launch-video-artifacts", path: VIDEO }]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].bucket).toBe("launch-video-media");
    expect(uploads[0].path).toMatch(new RegExp(`^${TENANT}/[0-9a-f-]{36}\\.mp4$`));
    const [tenant, fn, args] = rpc.mock.calls[0] as unknown as [string, string, { p_decision_class: string; p_body: Record<string, unknown> }];
    expect(tenant).toBe(TENANT);
    expect(fn).toBe("emit_decision");
    expect(args.p_decision_class).toBe(SOCIAL_PUBLISH_CLASS);
    expect(args.p_body).toMatchObject({
      channel: "youtube_video",
      source_action_id: ACTION,
      payload: { title: "Up to 52% off Zoomcar, until 5 October.", text: "Use code EOSS52 on zoomcar.in.", video_path: uploads[0].path, privacy: "public" },
    });
    expect(eqs).toContainEqual(["channel_actions", "tenant_id", TENANT]);
    expect(eqs).toContainEqual(["decisions", "tenant_id", TENANT]);
  });

  it("does nothing for a card on AI UGC Videos", async () => {
    const { sb, uploads } = fakeSb({ card: { ...YT_CARD, channel_slug: "generated_video" } });
    const rpc = vi.fn();
    expect(await stageYouTubeUploadForCard(sb, { tenant_id: TENANT, action_id: ACTION, video_path: VIDEO }, rpc as never)).toEqual({
      staged: false,
      reason: "not_youtube",
    });
    expect(uploads).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("stages once: a replay finds the earlier upload card and copies nothing", async () => {
    const { sb, uploads } = fakeSb({ card: YT_CARD, existing: [{ id: "dec-1" }] });
    const rpc = vi.fn();
    expect(await stageYouTubeUploadForCard(sb, { tenant_id: TENANT, action_id: ACTION, video_path: VIDEO }, rpc as never)).toEqual({
      staged: false,
      reason: "already_staged",
    });
    expect(uploads).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("skips a video over the media bucket's 50MB ceiling", async () => {
    const { sb, uploads } = fakeSb({ card: YT_CARD, bytes: 51 * 1024 * 1024 });
    const rpc = vi.fn();
    expect(await stageYouTubeUploadForCard(sb, { tenant_id: TENANT, action_id: ACTION, video_path: VIDEO }, rpc as never)).toMatchObject({
      reason: "too_large",
    });
    expect(uploads).toHaveLength(0);
  });
});

describe("uploadText", () => {
  it("falls back to the card title without its format label, and caps YouTube's 100-char title", () => {
    const t = uploadText({ channel_slug: "youtube_organic", title: `Hook: ${"x".repeat(150)}`, exec_payload: null });
    expect(t.title).toBe("x".repeat(100));
    expect(t.text).toBe("x".repeat(100));
  });
});
