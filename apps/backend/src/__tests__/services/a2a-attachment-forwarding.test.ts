
import { describe, it, expect } from "vitest";
import {
  isExactTenantPath,
  extractParentAttachmentRefs,
  normalizeChildAttachmentRefs,
  resolveForwardedContent,
  resolveTopActionImages,
  isA2aAttachmentForwardingEnabled,
  extractParentVideoPaths,
  parentTurnHadAttachment,
  lookbackThreadAttachmentRefs,
  lookbackThreadAttachmentsWithExpiry,
  LOOKBACK_WINDOW_MS,
} from "@/services/agents/a2a-attachment-forwarding";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "00000000-0000-0000-0000-000000000999";
const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";

const imgPath = (t: string, u: string) => `${t}/${u}.jpg`;
const docPath = (t: string, u: string) => `${t}/${u}.pdf`;

describe("isExactTenantPath", () => {
  it("accepts an exact tenant-scoped image/doc key", () => {
    expect(isExactTenantPath(imgPath(T, U1), T, "image")).toBe(true);
    expect(isExactTenantPath(docPath(T, U1), T, "doc")).toBe(true);
  });
  it("rejects a cross-tenant prefix", () => {
    expect(isExactTenantPath(imgPath(OTHER, U1), T, "image")).toBe(false);
    expect(isExactTenantPath(docPath(OTHER, U1), T, "doc")).toBe(false);
  });
  it("rejects an extra path segment (no tenant/x/uuid.ext smuggling)", () => {
    expect(isExactTenantPath(`${T}/sub/${U1}.jpg`, T, "image")).toBe(false);
  });
  it("rejects a wrong extension / kind mismatch", () => {
    expect(isExactTenantPath(docPath(T, U1), T, "image")).toBe(false);
    expect(isExactTenantPath(`${T}/${U1}.exe`, T, "doc")).toBe(false);
  });
  it("rejects non-string", () => {
    expect(isExactTenantPath(undefined as unknown as string, T, "image")).toBe(false);
  });
});

describe("extractParentAttachmentRefs", () => {
  it("pulls image + doc paths off the parent payload", () => {
    const refs = extractParentAttachmentRefs(
      { image_paths: [imgPath(T, U1)], doc_paths: [docPath(T, U2)] },
      T,
    );
    expect(refs).toEqual([
      { path: imgPath(T, U1), kind: "image" },
      { path: docPath(T, U2), kind: "doc" },
    ]);
  });
  it("drops cross-tenant paths (E3)", () => {
    const refs = extractParentAttachmentRefs(
      { image_paths: [imgPath(OTHER, U1)], doc_paths: [docPath(OTHER, U2)] },
      T,
    );
    expect(refs).toEqual([]);
  });
  it("caps at 4 images + 4 docs", () => {
    const imgs = Array.from({ length: 6 }, (_, i) => imgPath(T, `1111111${i}-1111-1111-1111-111111111111`));
    const docs = Array.from({ length: 6 }, (_, i) => docPath(T, `2222222${i}-2222-2222-2222-222222222222`));
    const refs = extractParentAttachmentRefs({ image_paths: imgs, doc_paths: docs }, T);
    expect(refs.filter((r) => r.kind === "image")).toHaveLength(4);
    expect(refs.filter((r) => r.kind === "doc")).toHaveLength(4);
  });
  it("returns [] for non-object / missing arrays", () => {
    expect(extractParentAttachmentRefs(null, T)).toEqual([]);
    expect(extractParentAttachmentRefs({ foo: 1 }, T)).toEqual([]);
  });
});

describe("normalizeChildAttachmentRefs", () => {
  it("keeps valid {path,kind} objects under the re-derived tenant", () => {
    const refs = normalizeChildAttachmentRefs(
      [
        { path: imgPath(T, U1), kind: "image" },
        { path: docPath(T, U2), kind: "doc" },
      ],
      T,
    );
    expect(refs).toHaveLength(2);
  });
  it("drops malformed entries + cross-tenant paths", () => {
    const refs = normalizeChildAttachmentRefs(
      [
        { path: imgPath(OTHER, U1), kind: "image" },
        { path: 123, kind: "doc" },
        { path: docPath(T, U2) },
        "nope",
        { path: docPath(T, U1), kind: "doc" },
      ],
      T,
    );
    expect(refs).toEqual([{ path: docPath(T, U1), kind: "doc" }]);
  });
  it("returns [] for non-array", () => {
    expect(normalizeChildAttachmentRefs(undefined, T)).toEqual([]);
  });
});

function mockSb(behavior: (bucket: string, path: string) => { ok: boolean }) {
  return {
    storage: {
      from(bucket: string) {
        return {
          async download(path: string) {
            const r = behavior(bucket, path);
            if (!r.ok) return { data: null, error: new Error("not found") };
            const blob = { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown as Blob;
            return { data: blob, error: null };
          },
        };
      },
    },
  } as unknown as Parameters<typeof resolveForwardedContent>[0];
}

describe("resolveForwardedContent", () => {
  it("returns null for empty refs (caller keeps text-only turn)", async () => {
    const out = await resolveForwardedContent(mockSb(() => ({ ok: true })), T, [], "do the thing");
    expect(out).toBeNull();
  });

  it("builds [document block, intent text] for a forwarded PDF", async () => {
    const out = (await resolveForwardedContent(
      mockSb(() => ({ ok: true })),
      T,
      [{ path: docPath(T, U1), kind: "doc" }],
      "update the website from this spec",
    )) as any[];
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe("document");
    expect(out[0].source.media_type).toBe("application/pdf");
    expect(out[out.length - 1]).toEqual({ type: "text", text: "update the website from this spec" });
  });

  it("names a loaded image's storage path beside the pixels, so a publish tool can take it", async () => {
    const out = (await resolveForwardedContent(
      mockSb(() => ({ ok: true })),
      T,
      [{ path: imgPath(T, U1), kind: "image" }],
      "post this image",
    )) as any[];
    const marker = out.find((b) => b.type === "text" && b.text.includes(imgPath(T, U1)));
    expect(marker.text).toContain("image_path");
    expect(out[out.length - 1]).toEqual({ type: "text", text: "post this image" });
  });

  it("surfaces a VISIBLE marker (not silent) when a validated file fails to download", async () => {
    const out = (await resolveForwardedContent(
      mockSb(() => ({ ok: false })),
      T,
      [{ path: docPath(T, U1), kind: "doc" }],
      "the intent",
    )) as any[];
    expect(out.some((b) => b.type === "text" && /could not be loaded/.test(b.text))).toBe(true);
    expect(out[out.length - 1]).toEqual({ type: "text", text: "the intent" });
  });

  it("drops a cross-tenant ref passed in (defense-in-depth) but still emits intent", async () => {
    const out = (await resolveForwardedContent(
      mockSb(() => ({ ok: true })),
      T,
      [{ path: docPath(OTHER, U1), kind: "doc" }],
      "intent only",
    )) as any[];
    expect(out.every((b) => b.type !== "document")).toBe(true);
    expect(out[out.length - 1]).toEqual({ type: "text", text: "intent only" });
  });
});

function mockThreadSb(row: { attachments: unknown } | null, error = false) {
  const filters: Record<string, unknown> = {};
  const chain: any = {
    select: () => chain,
    eq: (k: string, v: unknown) => ((filters[k] = v), chain),
    not: () => chain,
    gte: (k: string, v: unknown) => ((filters[`gte:${k}`] = v), chain),
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => (error ? { data: null, error: new Error("boom") } : { data: row, error: null }),
  };
  return { sb: { from: () => chain } as unknown as Parameters<typeof lookbackThreadAttachmentRefs>[0], filters };
}

describe("lookbackThreadAttachmentRefs", () => {
  const THREAD = "33333333-3333-3333-3333-333333333333";

  it("returns the thread's most recent user attachments, tenant-pinned", async () => {
    const { sb, filters } = mockThreadSb({ attachments: [{ path: imgPath(T, U1), kind: "image" }] });
    const refs = await lookbackThreadAttachmentRefs(sb, T, { thread_id: THREAD });
    expect(refs).toEqual([{ path: imgPath(T, U1), kind: "image" }]);
    expect(filters.tenant_id).toBe(T);
    expect(filters.thread_id).toBe(THREAD);
    expect(filters.sender_role).toBe("user");
  });

  it("drops cross-tenant + malformed entries from the stored attachments (E3)", async () => {
    const { sb } = mockThreadSb({
      attachments: [
        { path: imgPath(OTHER, U1), kind: "image" },
        { path: `${T}/sub/${U1}.jpg`, kind: "image" },
        { path: docPath(T, U2), kind: "doc" },
      ],
    });
    const refs = await lookbackThreadAttachmentRefs(sb, T, { thread_id: THREAD });
    expect(refs).toEqual([{ path: docPath(T, U2), kind: "doc" }]);
  });

  it("returns [] when the payload carries no thread_id (non-chat surfaces)", async () => {
    const { sb } = mockThreadSb({ attachments: [{ path: imgPath(T, U1), kind: "image" }] });
    expect(await lookbackThreadAttachmentRefs(sb, T, { slack: {} })).toEqual([]);
    expect(await lookbackThreadAttachmentRefs(sb, T, null)).toEqual([]);
    expect(await lookbackThreadAttachmentRefs(sb, T, { thread_id: 42 })).toEqual([]);
  });

  it("only looks back inside the follow-up window", async () => {
    const { sb, filters } = mockThreadSb({ attachments: [{ path: imgPath(T, U1), kind: "image" }] });
    await lookbackThreadAttachmentRefs(sb, T, { thread_id: THREAD });
    const since = Date.parse(filters["gte:created_at"] as string);
    expect(Math.abs(Date.now() - LOOKBACK_WINDOW_MS - since)).toBeLessThan(5_000);
  });

  it("returns [] when the turn carries a video (the video is the media)", async () => {
    const { sb } = mockThreadSb({ attachments: [{ path: imgPath(T, U1), kind: "image" }] });
    const refs = await lookbackThreadAttachmentRefs(sb, T, { thread_id: THREAD, video_paths: [`${T}/${U2}.mp4`] });
    expect(refs).toEqual([]);
  });

  it("soft-fails to [] on a read error or empty thread", async () => {
    expect(await lookbackThreadAttachmentRefs(mockThreadSb(null, true).sb, T, { thread_id: THREAD })).toEqual([]);
    expect(await lookbackThreadAttachmentRefs(mockThreadSb(null).sb, T, { thread_id: THREAD })).toEqual([]);
  });
});

function mockExpirySb(
  windowedRow: { attachments: unknown } | null,
  olderRow: { attachments: unknown } | null,
) {
  return {
    from: () => {
      let windowed = false;
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        gte: () => ((windowed = true), chain),
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: windowed ? windowedRow : olderRow, error: null }),
      };
      return chain;
    },
  } as unknown as Parameters<typeof lookbackThreadAttachmentsWithExpiry>[0];
}

describe("lookbackThreadAttachmentsWithExpiry", () => {
  const THREAD = "33333333-3333-3333-3333-333333333333";
  const row = { attachments: [{ path: imgPath(T, U1), kind: "image" }] };

  it("inside the window: refs, not expired", async () => {
    const out = await lookbackThreadAttachmentsWithExpiry(mockExpirySb(row, row), T, { thread_id: THREAD });
    expect(out).toEqual({ refs: [{ path: imgPath(T, U1), kind: "image" }], expiredUpload: false });
  });

  it("upload older than the window: no refs (window stands), expiredUpload reported", async () => {
    const out = await lookbackThreadAttachmentsWithExpiry(mockExpirySb(null, row), T, { thread_id: THREAD });
    expect(out).toEqual({ refs: [], expiredUpload: true });
  });

  it("thread never had a forwardable upload: not expired", async () => {
    const out = await lookbackThreadAttachmentsWithExpiry(mockExpirySb(null, null), T, { thread_id: THREAD });
    expect(out).toEqual({ refs: [], expiredUpload: false });
  });

  it("a failed windowed read is NOT reported as expired", async () => {
    const sb = mockExpirySb(null, row) as any;
    const from = sb.from;
    sb.from = () => {
      const c = from();
      const gte = c.gte;
      c.gte = () => {
        gte();
        c.maybeSingle = async () => ({ data: null, error: { message: "boom" } });
        return c;
      };
      return c;
    };
    const out = await lookbackThreadAttachmentsWithExpiry(sb, T, { thread_id: THREAD });
    expect(out).toEqual({ refs: [], expiredUpload: false });
  });

  it("an old row with only cross-tenant/malformed entries is NOT 'expired' (E3)", async () => {
    const poisoned = { attachments: [{ path: imgPath(OTHER, U1), kind: "image" }] };
    const out = await lookbackThreadAttachmentsWithExpiry(mockExpirySb(null, poisoned), T, { thread_id: THREAD });
    expect(out).toEqual({ refs: [], expiredUpload: false });
  });
});

describe("isA2aAttachmentForwardingEnabled", () => {
  const flagSb = (blob: Record<string, unknown> | null, error = false) =>
    ({
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return error ? { data: null, error: new Error("boom") } : { data: blob ? { blob } : null, error: null };
                  },
                };
              },
            };
          },
        };
      },
    }) as unknown as Parameters<typeof isA2aAttachmentForwardingEnabled>[0];

  it("true only when blob.a2a_attachment_forwarding === true", async () => {
    expect(await isA2aAttachmentForwardingEnabled(flagSb({ a2a_attachment_forwarding: true }))).toBe(true);
  });
  it("false when flag absent / false", async () => {
    expect(await isA2aAttachmentForwardingEnabled(flagSb({}))).toBe(false);
    expect(await isA2aAttachmentForwardingEnabled(flagSb({ a2a_attachment_forwarding: false }))).toBe(false);
  });
  it("soft-fails to false on a read error (never silently arms)", async () => {
    expect(await isA2aAttachmentForwardingEnabled(flagSb(null, true))).toBe(false);
  });
});

describe("extractParentVideoPaths", () => {
  it("forwards a well-formed video path owned by the run's tenant", () => {
    expect(extractParentVideoPaths({ video_paths: [`${T}/${U1}.mp4`] }, T)).toEqual([
      `${T}/${U1}.mp4`,
    ]);
  });

  it("drops ANOTHER tenant's path — the isolation boundary", () => {
    expect(extractParentVideoPaths({ video_paths: [`${OTHER}/${U1}.mp4`] }, T)).toEqual([]);
  });

  it("drops a URL, a nested key and a non-mp4 extension", () => {
    const payload = {
      video_paths: [
        "https://media.bebee.com/clip.mp4",
        `${T}/nested/${U1}.mp4`,
        `${T}/${U1}.mov`,
        `${T}/not-a-uuid.mp4`,
      ],
    };
    expect(extractParentVideoPaths(payload, T)).toEqual([]);
  });

  it("caps at one — every consumer takes a single video", () => {
    expect(
      extractParentVideoPaths({ video_paths: [`${T}/${U1}.mp4`, `${T}/${U2}.mp4`] }, T),
    ).toEqual([`${T}/${U1}.mp4`]);
  });

  it("is inert on a payload that carries no video_paths", () => {
    expect(extractParentVideoPaths({ image_paths: [`${T}/${U1}.png`] }, T)).toEqual([]);
    expect(extractParentVideoPaths(null, T)).toEqual([]);
    expect(extractParentVideoPaths({ video_paths: "not-an-array" }, T)).toEqual([]);
  });
});

describe("parentTurnHadAttachment (GS18 flag-off note)", () => {
  it("is true for an upload, a Slack image, or a video on this turn", () => {
    expect(parentTurnHadAttachment({ image_paths: [imgPath(T, U1)] }, T)).toBe(true);
    expect(
      parentTurnHadAttachment({ slack: { images: [{ url: "https://files.slack.com/x", mimetype: "image/png" }] } }, T),
    ).toBe(true);
    expect(parentTurnHadAttachment({ video_paths: [`${T}/${U1}.mp4`] }, T)).toBe(true);
  });
  it("is false for a text-only turn or another tenant's path", () => {
    expect(parentTurnHadAttachment({ intent: "stage it" }, T)).toBe(false);
    expect(parentTurnHadAttachment({ image_paths: [imgPath(OTHER, U1)] }, T)).toBe(false);
    expect(parentTurnHadAttachment(null, T)).toBe(false);
  });
});

describe("resolveTopActionImages (a top-action run sees the founder's own upload)", () => {
  it("shows this tenant's image with its path, then the brief", async () => {
    const out = (await resolveTopActionImages(mockSb(() => ({ ok: true })), T, [imgPath(T, U1)], "write the caption")) as any[];
    expect(out[0].type).toBe("image");
    expect(out.some((b) => b.type === "text" && b.text.includes(imgPath(T, U1)))).toBe(true);
    expect(out[out.length - 1]).toEqual({ type: "text", text: "write the caption" });
  });

  it("never downloads another tenant's path or a URL", async () => {
    const seen: string[] = [];
    const sb = mockSb((_b, p) => {
      seen.push(p);
      return { ok: true };
    });
    expect(await resolveTopActionImages(sb, T, [imgPath(OTHER, U1), "https://evil.example/a.jpg"], "x")).toBeNull();
    expect(seen).toEqual([]);
  });
});
