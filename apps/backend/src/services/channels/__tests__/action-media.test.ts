import { describe, it, expect, vi } from "vitest";

vi.mock("@/routes/run-artifacts/file-url", () => ({
  signTenantArtifactPath: vi.fn(async (tenant: string, path: string, _ttl: unknown, _b: unknown, d: unknown, t?: { width: number }) =>
    path.startsWith(`${tenant}/`)
      ? `https://storage.example/${path}${t ? `?w=${t.width}` : ""}${d ? `${t ? "&" : "?"}download=${String(d)}` : ""}`
      : null,
  ),
}));

const artifactRows: Array<{ id: string; storage_path: string }> = [];
const tenantsAsked: string[] = [];
let fakeArtifacts = false;
vi.mock("@/services/tenant-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/tenant-client")>();
  return {
    ...real,
    tenantClient: ((t: string) => {
      if (!fakeArtifacts) return real.tenantClient(t as never);
      tenantsAsked.push(t);
      return {
        from: () => ({
          select: () => ({
            in: (_c: string, paths: string[]) => ({
              limit: async () => ({ data: artifactRows.filter((r) => paths.includes(r.storage_path)), error: null }),
            }),
          }),
        }),
      };
    }) as never,
  };
});

import { attachRunImage, attachRunImages, signActionMedia, type RunImage } from "../action-media";

const T = "11111111-1111-1111-1111-111111111111";
const images: RunImage[] = [
  { id: "a1", storage_path: `${T}/run/social-1-scrim.png`, bucket: null, filename: "social-1-scrim.png" },
  { id: "a2", storage_path: `${T}/run/social-2-block.png`, bucket: null, filename: "social-2-block.png" },
];

describe("attachRunImage", () => {
  it("picks the rendered file the pin's copy names", () => {
    const m = attachRunImage("Title: Linen runner\nImage: Social-2-Block.png\nBoard: Table", "Upload pin: Linen runner", images);
    expect(m).toMatchObject({ kind: "image", artifact_id: "a2", storage_path: `${T}/run/social-2-block.png` });
  });

  it("uses the pin's own alt text, not the action title", () => {
    const m = attachRunImage("Image: social-1-scrim.png\n**Alt text:** Sage runner on an oak table", "Upload pin: x", images);
    expect(m?.alt).toBe("Sage runner on an oak table");
  });

  it("a blank alt line falls back to the title instead of swallowing the next line", () => {
    const m = attachRunImage("Image: social-1-scrim.png\nAlt text:\nDestination: https://shop.example/x", "Upload pin: x", images);
    expect(m?.alt).toBe("Upload pin: x");
  });

  it("names no file, gets no image", () => {
    expect(attachRunImage("Title only", "t", images)).toBeNull();
    expect(attachRunImage("Image: social-1-scrim.png", "t", [])).toBeNull();
  });
});

describe("attachRunImages", () => {
  it("keeps named matches and pairs the rest in render order when the counts agree", () => {
    const out = attachRunImages(
      [{ content: "Title: Two\nImage: social-2-block.png", alt: "Upload pin: Two" }, null, { content: "Title: One\nAlt text: Runner", alt: "Upload pin: One" }],
      images,
    );
    expect(out[0]).toMatchObject({ artifact_id: "a2" });
    expect(out[1]).toBeNull();
    expect(out[2]).toMatchObject({ artifact_id: "a1", alt: "Runner" });
  });

  it.each(["tab-task-step-1.png", "browser-task-abc123-1.png", "BROWSER-TASK-abc123-2.png", "screenshot.png"])("never pairs %s with an unnamed post", (filename) => {
    const shot: RunImage = { id: "s1", storage_path: `${T}/run/${filename}`, bucket: null, filename };
    expect(attachRunImages([{ content: "Title: One", alt: "a" }], [shot])).toEqual([null]);
    expect(attachRunImages([{ content: "Title: One", alt: "a" }], [shot, images[0]])[0]).toMatchObject({ artifact_id: "a1" });
  });

  it("guesses nothing when unnamed posts and spare images do not line up", () => {
    const out = attachRunImages([{ content: "Title: One", alt: "a" }, { content: "Title: Two", alt: "b" }, { content: "Title: Three", alt: "c" }], images);
    expect(out).toEqual([null, null, null]);
    expect(attachRunImages([{ content: "Title: One", alt: "a" }], [])).toEqual([null]);
  });
});

describe("signActionMedia", () => {
  it("hands the card a signed url and strips the storage path", async () => {
    const [a] = await signActionMedia(T, [
      { body: { step: {}, media: { kind: "image", artifact_id: "a1", storage_path: `${T}/run/x.png`, bucket: null, alt: "pin" } } },
    ]);
    expect((a.body as any).media).toEqual({ kind: "image", url: `https://storage.example/${T}/run/x.png?w=480`, alt: "pin" });
  });

  it("never signs another tenant's path: the card loses its image instead", async () => {
    const [a] = await signActionMedia(T, [
      { body: { media: { kind: "image", artifact_id: "x", storage_path: "22222222-2222-2222-2222-222222222222/run/x.png", bucket: null, alt: "" } } },
    ]);
    expect((a.body as any).media).toBeUndefined();
  });

  it("signs a VIDEO as the file itself (no image transform), with a download url and the AI label", async () => {
    const { signTenantArtifactPath } = await import("@/routes/run-artifacts/file-url");
    const [a] = await signActionMedia(T, [
      {
        body: {
          media: {
            kind: "video",
            storage_path: `${T}/run/ai-ugc-video-1.mp4`,
            bucket: "launch-video-artifacts",
            filename: "ai-ugc-video-1.mp4",
            alt: "AI-generated video",
            ai_generated: true,
          },
        },
      },
    ]);
    expect((a.body as any).media).toEqual({
      kind: "video",
      url: `https://storage.example/${T}/run/ai-ugc-video-1.mp4`,
      download_url: `https://storage.example/${T}/run/ai-ugc-video-1.mp4?download=ai-ugc-video-1.mp4`,
      alt: "AI-generated video",
      ai_generated: true,
    });
    const calls = (signTenantArtifactPath as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => c[1] === `${T}/run/ai-ugc-video-1.mp4`,
    );
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c[5]).toBeUndefined();
  });

  it("hands a card video its library artifact id, read for this tenant, so the card can post it", async () => {
    artifactRows.splice(0, artifactRows.length, { id: "art-9", storage_path: `${T}/run/ai-ugc-video-2.mp4` });
    tenantsAsked.length = 0;
    fakeArtifacts = true;
    const [a, b] = await signActionMedia(T, [
      { body: { media: { kind: "video", storage_path: `${T}/run/ai-ugc-video-2.mp4`, bucket: "launch-video-artifacts", alt: "v", ai_generated: true } } },
      { body: { media: { kind: "video", storage_path: `${T}/run/ai-ugc-video-3.mp4`, bucket: "launch-video-artifacts", alt: "v", ai_generated: true } } },
    ]);
    expect((a.body as any).media.artifact_id).toBe("art-9");
    expect((b.body as any).media).not.toHaveProperty("artifact_id");
    expect(tenantsAsked).toEqual([T]);
    artifactRows.length = 0;
    fakeArtifacts = false;
  });

  it("never signs another tenant's video", async () => {
    const [a] = await signActionMedia(T, [
      { body: { media: { kind: "video", storage_path: "22222222-2222-2222-2222-222222222222/run/v.mp4", bucket: null, alt: "" } } },
    ]);
    expect((a.body as any).media).toBeUndefined();
  });

  it("leaves bodies with no media untouched", async () => {
    const input = [{ body: { step: { title: "x" } } }];
    expect(await signActionMedia(T, input)).toBe(input);
  });
});

describe("recordChannelRunActions image read", () => {
  it("a post that is an image only because it was STAGED as x_image still reads and attaches its image", async () => {
    const { recordChannelRunActions } = await import("../channel-actions");
    const runImages = vi.fn(async () => images);
    const rpc = vi.fn(async (_t: unknown, _n: string, p: { p_actions: Array<{ action_type: string; body: any }> }) => {
      captured = p.p_actions;
      return { data: { inserted: 1, ids: [] }, error: null };
    });
    let captured: Array<{ action_type: string; body: any }> = [];
    await recordChannelRunActions(
      {
        tenantId: T,
        runId: "22222222-2222-2222-2222-222222222222",
        channelSlug: "x_organic",
        envelope: {},
        bodies: [{ step: { title: "Post it", deliverable: { kind: "post", label: "l", content: "Launch day. Image: social-1-scrim.png" } }, position: 1, of: 1 } as never],
        redo: null,
      },
      {
        rpc: rpc as never,
        loadScoreContext: (async () => ({
          channel_in_plan: false,
          goal_metric_keys: new Set<string>(),
          rejected_title_keys: new Set<string>(),
          rejected_ids: new Set<string>(),
        })) as never,
        stagedPosts: async () => [{ channel: "x_image", text: "Launch day. Image: social-1-scrim.png" }],
        runImages,
        ledger: { figureWasRead: () => true, ledgerIsEmpty: () => true } as never,
      },
    );
    expect(runImages).toHaveBeenCalled();
    expect(captured[0].action_type).toBe("image_post");
    expect(captured[0].body.media).toMatchObject({ artifact_id: "a1" });
  });
});
