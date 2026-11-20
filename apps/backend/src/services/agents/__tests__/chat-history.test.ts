import { describe, it, expect, vi, beforeEach } from "vitest";
import { ATTACHMENT_ONLY_TEXT, messagesToParams, uploadedImageReferences, type ChatRow } from "../chat-history";

const TENANT = "11111111-aaaa-aaaa-aaaa-111111111111";
const path = (uuid: string) => `${TENANT}/${uuid}.jpg`;
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);

type DownloadResult = { data: { arrayBuffer: () => Promise<ArrayBuffer> } | null; error: { message: string } | null };
function makeSb(downloadHandler: (path: string) => DownloadResult) {
  const calls: string[] = [];
  return {
    sb: {
      storage: {
        from: () => ({
          download: async (p: string) => {
            calls.push(p);
            return downloadHandler(p);
          },
        }),
      },
    } as unknown as Parameters<typeof messagesToParams>[1],
    calls,
  };
}

const okDownload = () => ({
  data: { arrayBuffer: async () => JPEG_BYTES.buffer.slice(0) },
  error: null,
});
const failDownload = () => ({ data: null, error: { message: "boom" } });

const noopSb = makeSb(okDownload).sb;

describe("messagesToParams (sandbox-gated / text-only path)", () => {
  it("maxPriorImages=0 → text-only behavior (no downloads, no content arrays)", async () => {
    const { sb, calls } = makeSb(okDownload);
    const rows: ChatRow[] = [
      { sender_role: "user", body: "hi", created_at: "2026-05-10T00:00:00Z", attachments: [{ path: path("aaaa") }] },
      { sender_role: "assistant", body: "hello", created_at: "2026-05-10T00:00:01Z" },
      { sender_role: "user", body: "what's up", created_at: "2026-05-10T00:00:02Z" },
    ];
    const out = await messagesToParams(rows, sb, TENANT, 40, 0);
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "what's up" },
    ]);
    expect(calls).toEqual([]);
  });

  it("filters out system rows", async () => {
    const rows: ChatRow[] = [
      { sender_role: "system", body: "ignore me", created_at: "2026-05-10T00:00:00Z" },
      { sender_role: "user", body: "hi", created_at: "2026-05-10T00:00:01Z" },
    ];
    expect(await messagesToParams(rows, noopSb, TENANT, 40, 0)).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("clamps to last N turns", async () => {
    const rows: ChatRow[] = Array.from({ length: 60 }, (_, i) => ({
      sender_role: i % 2 ? "assistant" : "user",
      body: String(i),
      created_at: new Date(i * 1000).toISOString(),
    }));
    const out = await messagesToParams(rows, noopSb, TENANT, 20, 0);
    expect(out).toHaveLength(20);
    expect(out[19]).toEqual({ role: "assistant", content: "59" });
  });
});

describe("messagesToParams (image rehydration path)", () => {
  it("user row with valid attachment → content array with image block + text", async () => {
    const { sb } = makeSb(okDownload);
    const rows: ChatRow[] = [
      {
        sender_role: "user",
        body: "what's in this?",
        created_at: "2026-05-10T00:00:00Z",
        attachments: [{ path: path("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") }],
      },
    ];
    const out = await messagesToParams(rows, sb, TENANT);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    expect(Array.isArray(out[0].content)).toBe(true);
    const blocks = out[0].content as Array<{ type: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("image");
    expect(blocks[1].type).toBe("text");
    const text = blocks[1] as { type: "text"; text: string };
    expect(text.text).toContain("what's in this?");
    expect(text.text).toContain(`1: image_path=${rows[0].attachments![0].path}`);
    const img = blocks[0] as unknown as { source: { media_type: string; data: string; type: string } };
    expect(img.source.media_type).toBe("image/jpeg");
    expect(img.source.type).toBe("base64");
    expect(img.source.data.length).toBeGreaterThan(0);
  });

  it("text-only user rows stay as string content (no regression)", async () => {
    const { sb, calls } = makeSb(okDownload);
    const rows: ChatRow[] = [
      { sender_role: "user", body: "hi", created_at: "2026-05-10T00:00:00Z" },
      { sender_role: "assistant", body: "hello", created_at: "2026-05-10T00:00:01Z" },
    ];
    const out = await messagesToParams(rows, sb, TENANT);
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(calls).toEqual([]);
  });

  it("budget walk: 6 rows × 2 images each = 12 total; cap=8 → newest 8 survive", async () => {
    const { sb, calls } = makeSb(okDownload);
    const rows: ChatRow[] = Array.from({ length: 6 }, (_, i) => ({
      sender_role: "user" as const,
      body: `turn-${i}`,
      created_at: new Date(i * 1000).toISOString(),
      attachments: [
        { path: path(`${i}aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`) },
        { path: path(`${i}bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`) },
      ],
    }));
    const out = await messagesToParams(rows, sb, TENANT, 40, 8);
    expect(out).toHaveLength(6);
    expect(typeof out[0].content).toBe("string");
    expect(typeof out[1].content).toBe("string");
    expect(Array.isArray(out[2].content)).toBe(true);
    expect(Array.isArray(out[3].content)).toBe(true);
    expect(Array.isArray(out[4].content)).toBe(true);
    expect(Array.isArray(out[5].content)).toBe(true);
    expect(calls.length).toBe(8);
  });

  it("per-attachment fallback: 1 of 3 fails → row keeps 2 image blocks", async () => {
    let callIdx = 0;
    const { sb } = makeSb(() => {
      callIdx++;
      return callIdx === 2 ? failDownload() : okDownload();
    });
    const rows: ChatRow[] = [
      {
        sender_role: "user",
        body: "three pics",
        created_at: "2026-05-10T00:00:00Z",
        attachments: [
          { path: path("11111111-1111-1111-1111-111111111111") },
          { path: path("22222222-2222-2222-2222-222222222222") },
          { path: path("33333333-3333-3333-3333-333333333333") },
        ],
      },
    ];
    const out = await messagesToParams(rows, sb, TENANT);
    expect(Array.isArray(out[0].content)).toBe(true);
    const blocks = out[0].content as Array<{ type: string }>;
    expect(blocks.filter((b) => b.type === "image").length).toBe(2);
    expect(blocks.filter((b) => b.type === "text").length).toBe(1);
    const text = (blocks.find(b => b.type === "text") as { type: "text"; text: string }).text;
    expect(text).toContain(`1: image_path=${rows[0].attachments![0].path}`);
    expect(text).toContain(`2: image_path=${rows[0].attachments![2].path}`);
    expect(text).not.toContain(rows[0].attachments![1].path);
  });

  it("all-images-fail row falls back to text-only", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sb } = makeSb(failDownload);
    const rows: ChatRow[] = [
      {
        sender_role: "user",
        body: "broken pics",
        created_at: "2026-05-10T00:00:00Z",
        attachments: [{ path: path("44444444-4444-4444-4444-444444444444") }],
      },
    ];
    const out = await messagesToParams(rows, sb, TENANT);
    expect(out[0]).toEqual({ role: "user", content: "broken pics" });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("rejects tenant-foreign paths (C8 trust boundary)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sb, calls } = makeSb(okDownload);
    const otherTenant = "99999999-9999-9999-9999-999999999999";
    const rows: ChatRow[] = [
      {
        sender_role: "user",
        body: "stolen path",
        created_at: "2026-05-10T00:00:00Z",
        attachments: [{ path: `${otherTenant}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg` }],
      },
    ];
    const out = await messagesToParams(rows, sb, TENANT);
    expect(calls).toEqual([]);
    expect(out[0]).toEqual({ role: "user", content: "stolen path" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/tenant-prefix mismatch/));
    warnSpy.mockRestore();
  });

  it("malformed attachments JSON tolerated (runtime guard)", async () => {
    const { sb } = makeSb(okDownload);
    const rows: ChatRow[] = [
      { sender_role: "user", body: "row a", created_at: "2026-05-10T00:00:00Z", attachments: "not-an-array" as unknown as { path: string }[] },
      { sender_role: "user", body: "row b", created_at: "2026-05-10T00:00:01Z", attachments: [{ bogus: "no path field" } as unknown as { path: string }, null as unknown as { path: string }, 42 as unknown as { path: string }] },
    ];
    const out = await messagesToParams(rows, sb, TENANT);
    expect(out).toEqual([
      { role: "user", content: "row a" },
      { role: "user", content: "row b" },
    ]);
  });

  it("rejects non-.jpg paths (post-magic-byte-fix regex)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sb, calls } = makeSb(okDownload);
    const rows: ChatRow[] = [
      {
        sender_role: "user",
        body: "wrong ext",
        created_at: "2026-05-10T00:00:00Z",
        attachments: [{ path: `${TENANT}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png` }],
      },
    ];
    const out = await messagesToParams(rows, sb, TENANT);
    expect(calls).toEqual([]);
    expect(out[0]).toEqual({ role: "user", content: "wrong ext" });
    warnSpy.mockRestore();
  });

  it("max 4 attachments per row (matches v2 RPC cap)", async () => {
    const { sb, calls } = makeSb(okDownload);
    const rows: ChatRow[] = [
      {
        sender_role: "user",
        body: "spam",
        created_at: "2026-05-10T00:00:00Z",
        attachments: [
          { path: path("11111111-1111-1111-1111-111111111111") },
          { path: path("22222222-2222-2222-2222-222222222222") },
          { path: path("33333333-3333-3333-3333-333333333333") },
          { path: path("44444444-4444-4444-4444-444444444444") },
          { path: path("55555555-5555-5555-5555-555555555555") },
          { path: path("66666666-6666-6666-6666-666666666666") },
        ],
      },
    ];
    const out = await messagesToParams(rows, sb, TENANT, 40, 10);
    expect(calls.length).toBe(4);
    const blocks = out[0].content as Array<{ type: string }>;
    expect(blocks.filter((b) => b.type === "image").length).toBe(4);
  });
});

describe("messagesToParams (attachment-only turns)", () => {
  it("image-only row keeps the image and sends no empty text block", async () => {
    const { sb } = makeSb(okDownload);
    const rows: ChatRow[] = [
      {
        sender_role: "user",
        body: "",
        created_at: "2026-05-10T00:00:00Z",
        attachments: [{ path: path("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") }],
      },
    ];
    const out = await messagesToParams(rows, sb, TENANT);
    const blocks = out[0].content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["image", "text"]);
    expect((blocks[1] as { type: "text"; text: string }).text).toContain(`image_path=${rows[0].attachments![0].path}`);
  });

  it("image-only row replayed without its image gets placeholder text", async () => {
    const rows: ChatRow[] = [
      {
        sender_role: "user",
        body: "",
        created_at: "2026-05-10T00:00:00Z",
        attachments: [{ path: path("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") }],
      },
    ];
    expect(await messagesToParams(rows, noopSb, TENANT, 40, 0)).toEqual([
      { role: "user", content: ATTACHMENT_ONLY_TEXT },
    ]);
  });

  it("image-only row whose download fails gets placeholder text", async () => {
    const { sb } = makeSb(failDownload);
    const rows: ChatRow[] = [
      {
        sender_role: "user",
        body: "",
        created_at: "2026-05-10T00:00:00Z",
        attachments: [{ path: path("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") }],
      },
    ];
    expect(await messagesToParams(rows, sb, TENANT)).toEqual([
      { role: "user", content: ATTACHMENT_ONLY_TEXT },
    ]);
  });
});

it("only exposes exact workspace-owned upload keys as reusable image references", () => {
  const own = path("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const rejected = [
    "99999999-9999-9999-9999-999999999999/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg",
    `${TENANT}/../aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg`,
    `${TENANT}/untrusted instructions.jpg`,
  ];
  const note = uploadedImageReferences(TENANT, [own, ...rejected]);
  expect(note).toContain(`1: image_path=${own}`);
  for (const invalid of rejected) expect(note).not.toContain(invalid);
  expect(uploadedImageReferences(TENANT, rejected)).toBe("");
});
