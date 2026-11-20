
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  upload: vi.fn(),
  upsertSingle: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: mocks.rpc }),
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => Promise.resolve({ count: 0, error: null }) }) }),
      upsert: () => ({ select: () => ({ single: () => mocks.upsertSingle() }) }),
      update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
    }),
  }),
  tenantStorage: () => ({
    from: () => ({ upload: (...a: unknown[]) => mocks.upload(...a) }),
  }),
}));

vi.mock("../guard", () => ({
  assertRunTenantOwnership: async () => "tenant-OWNER",
}));
vi.mock("../run-binding", () => ({
  artifactRunBinding: async () => ({ agent_slug: "pm", thread_id: null }),
}));
vi.mock("@/services/tools/slack/upload_file", () => ({ uploadFileToThread: vi.fn() }));

const isConfigured = vi.fn();
const genImage = vi.fn();
vi.mock("@/services/media-router/router", () => ({
  isTaskConfigured: (t: unknown) => isConfigured(t),
  routeImage: (t: unknown, r: unknown) => genImage(t, r),
  estimateCost: () => 0.06,
}));
const canAfford = vi.fn();
const flushCharges = vi.fn();
vi.mock("@/services/media-router/charge", () => ({
  canAffordMedia: (t: unknown, c: unknown) => canAfford(t, c),
  flushCharges: (p: unknown) => flushCharges(p),
}));

const ONE_PIXEL_PNG_HEX =
  "89504E470D0A1A0A0000000D49484452000000010000000108000000003A7E9B550000000A49444154789C636800000082008177CD72B60000000049454E44AE426082";

function pngResponse() {
  const buf = Buffer.from(ONE_PIXEL_PNG_HEX, "hex");
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  } as unknown as Response;
}

const CTX = { tenant_id: "tenant-CALLER", run_id: "run-9" };
const INPUT = {
  title: "Post",
  body: "Hello world body text.",
  filename: "post.html",
  image_concepts: ["a moody city street", "a bright desk scene"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: "charged", error: null });
  mocks.upload.mockResolvedValue({ data: { path: "p" }, error: null });
  mocks.upsertSingle.mockResolvedValue({ data: { id: "artifact-1" }, error: null });
  isConfigured.mockResolvedValue(true);
  genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/x.png", cost_usd: 0.06, model: "seedream" });
  canAfford.mockResolvedValue(true);
  flushCharges.mockResolvedValue(undefined);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(pngResponse());
});

const uploadedHtml = (): string => {
  const call = mocks.upload.mock.calls.at(-1);
  const body = call?.[1];
  return typeof body === "string" ? body : Buffer.from(body as Uint8Array).toString("utf8");
};

const keys = () =>
  mocks.rpc.mock.calls.map((c) => (c[1] as { p_idempotency_key: string }).p_idempotency_key);

describe("deliverBlogHtml — Higgsfield meter", () => {
  it("meters each hero image with a DISTINCT key, against the RUN'S owning tenant", async () => {
    const { deliverBlogHtml } = await import("../deliver-html");
    const out = await deliverBlogHtml(CTX, INPUT);

    expect(out.images_generated).toBe(2);
    expect(genImage).toHaveBeenCalledTimes(2);
    expect(keys().map((k: string) => k.split(":").slice(0, 3).join(":"))).toEqual(["run-9:blog-hero:0", "run-9:blog-hero:1"]);
    expect(new Set(keys()).size).toBe(2);
    for (const c of mocks.rpc.mock.calls) {
      expect((c[1] as { p_tenant_id: string }).p_tenant_id).toBe("tenant-OWNER");
    }
  });

  it("RETRY DOUBLE-SPEND: a re-run of the same run replays the keys → 'already', vendor NOT re-called, blog still ships", async () => {
    const claimed = new Set<string>();
    mocks.rpc.mockImplementation(async (_fn: string, args: { p_idempotency_key: string }) => {
      if (claimed.has(args.p_idempotency_key)) return { data: "already", error: null };
      claimed.add(args.p_idempotency_key);
      return { data: "charged", error: null };
    });
    const { deliverBlogHtml } = await import("../deliver-html");

    const first = await deliverBlogHtml(CTX, INPUT);
    expect(first.images_generated).toBe(2);
    expect(genImage).toHaveBeenCalledTimes(2);

    genImage.mockClear();
    const retry = await deliverBlogHtml(CTX, INPUT);
    expect(genImage).not.toHaveBeenCalled();
    expect(retry.images_generated).toBe(0);
    expect(retry.artifact_id).toBe("artifact-1");
  });

  it("FAIL CLOSED: meter RPC error → generatePlatformImage NEVER called, blog still ships text-only", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    const { deliverBlogHtml } = await import("../deliver-html");
    const out = await deliverBlogHtml(CTX, INPUT);
    expect(genImage).not.toHaveBeenCalled();
    expect(out.images_generated).toBe(0);
    expect(out.artifact_id).toBe("artifact-1");
  });

  it("FAIL SOFT: over_cap drops that image; the other image and the blog are unaffected", async () => {
    mocks.rpc.mockImplementation(async (_fn: string, args: { p_idempotency_key: string }) => ({
      data: args.p_idempotency_key.startsWith("run-9:blog-hero:0:") ? "charged" : "over_cap",
      error: null,
    }));
    const { deliverBlogHtml } = await import("../deliver-html");
    const out = await deliverBlogHtml(CTX, INPUT);
    expect(genImage).toHaveBeenCalledTimes(1);
    expect(out.images_generated).toBe(1);
    expect(out.artifact_id).toBe("artifact-1");
  });

  it("cap setting unset: the meter still caps the tenant at the built-in 100 a day, and the image under it is made", async () => {
    const prev = process.env.MEDIA_DAILY_GENERATE_CAP;
    delete process.env.MEDIA_DAILY_GENERATE_CAP;
    delete process.env.HIGGSFIELD_DAILY_GENERATE_CAP;
    try {
      const { deliverBlogHtml } = await import("../deliver-html");
      const out = await deliverBlogHtml(CTX, INPUT);
      expect(out.images_generated).toBe(2);
      expect(mocks.rpc).toHaveBeenCalledWith(
        "consume_higgsfield_generate_or_reject",
        expect.objectContaining({ p_daily_cap: 100 }),
      );
    } finally {
      if (prev === undefined) delete process.env.MEDIA_DAILY_GENERATE_CAP;
      else process.env.MEDIA_DAILY_GENERATE_CAP = prev;
    }
  });
});

describe("deliverBlogHtml — media router + credit charge", () => {
  it("(R1) routes image.hero with the suffix and charges both delivered heroes", async () => {
    const { deliverBlogHtml } = await import("../deliver-html");
    const out = await deliverBlogHtml(CTX, INPUT);

    expect(out.images_generated).toBe(2);
    expect(genImage).toHaveBeenNthCalledWith(1, "image.hero", {
      prompt: "a moody city street, no text, no logos, no watermarks",
      aspect_ratio: "16:9",
    });
    expect(canAfford).toHaveBeenCalledTimes(2);
    expect(canAfford).toHaveBeenCalledWith("tenant-OWNER", 0.06);

    expect(flushCharges).toHaveBeenCalledTimes(1);
    const charges = flushCharges.mock.calls[0][0] as Array<{ key: string }>;
    expect(charges.map((x) => x.key.split(":").slice(0, 3).join(":"))).toEqual([
      "run-9:blog-hero:0",
      "run-9:blog-hero:1",
    ]);
    expect(charges[0]).toMatchObject({
      cost_usd: 0.06,
      task: "image.hero",
      tenant_id: "tenant-OWNER",
      run_id: "run-9",
      model: "seedream",
    });
    expect(flushCharges.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.upload.mock.invocationCallOrder[0],
    );
    expect(flushCharges.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.upsertSingle.mock.invocationCallOrder[0],
    );
  });

  it("(R2) cannot afford → no vendor call, the blog still ships, nothing charged", async () => {
    canAfford.mockResolvedValue(false);
    const { deliverBlogHtml } = await import("../deliver-html");
    const out = await deliverBlogHtml(CTX, INPUT);
    expect(genImage).not.toHaveBeenCalled();
    expect(out.images_generated).toBe(0);
    expect(out.artifact_id).toBe("artifact-1");
    expect(flushCharges.mock.calls[0]?.[0] ?? []).toEqual([]);
  });

  it("(R3) a FAILED artifact store charges nothing", async () => {
    mocks.upload.mockResolvedValue({ data: null, error: { message: "bucket down" } });
    const { deliverBlogHtml } = await import("../deliver-html");
    await expect(deliverBlogHtml(CTX, INPUT)).rejects.toThrow(/bucket down/);
    expect(genImage).toHaveBeenCalledTimes(2);
    expect(flushCharges).not.toHaveBeenCalled();
  });

  it("(R4) the run_artifacts row failing charges nothing either", async () => {
    mocks.upsertSingle.mockResolvedValue({ data: null, error: { message: "row rejected" } });
    const { deliverBlogHtml } = await import("../deliver-html");
    await expect(deliverBlogHtml(CTX, INPUT)).rejects.toThrow(/row rejected/);
    expect(flushCharges).not.toHaveBeenCalled();
  });

  it("(R5) image generation NOT configured → no vendor call, blog ships, nothing charged", async () => {
    isConfigured.mockResolvedValue(false);
    const { deliverBlogHtml } = await import("../deliver-html");
    const out = await deliverBlogHtml(CTX, INPUT);
    expect(isConfigured).toHaveBeenCalledWith("image.hero");
    expect(genImage).not.toHaveBeenCalled();
    expect(out.images_generated).toBe(0);
    expect(out.artifact_id).toBe("artifact-1");
    expect(flushCharges.mock.calls[0]?.[0] ?? []).toEqual([]);
  });
});

describe("deliverBlogHtml — hero images ship at web weight", () => {
  async function bigPng(): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    const w = 2400;
    const h = 1350;
    const px = Buffer.alloc(w * h * 3);
    for (let i = 0; i < px.length; i += 3) {
      px[i] = (i / 97) % 256;
      px[i + 1] = (i / 31) % 256;
      px[i + 2] = (i / 7) % 256;
    }
    return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  }

  function respondWith(buf: Buffer) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    } as unknown as Response);
  }

  it("re-encodes a full-resolution hero to WebP, an order of magnitude smaller", async () => {
    const original = await bigPng();
    respondWith(original);
    const { deliverBlogHtml } = await import("../deliver-html");
    const res = await deliverBlogHtml(CTX, INPUT);
    expect(res).toBeTruthy();
    const html = uploadedHtml();
    expect(html).toContain("data:image/webp;base64,");
    expect(html).not.toContain("data:image/png;base64,");
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(2 * 1024 * 1024);
    expect(original.byteLength).toBeGreaterThan(200 * 1024);
  });

  it("FAIL SOFT: an undecodable image keeps its original bytes rather than vanishing", async () => {
    respondWith(Buffer.from("not really a png at all", "utf8"));
    const { deliverBlogHtml } = await import("../deliver-html");
    await deliverBlogHtml(CTX, INPUT);
    expect(uploadedHtml()).toContain("data:image/png;base64,");
  });
});

describe("deliverBlogHtml — the embed ceiling holds on the fail-soft path too", () => {
  it("drops an undecodable image that is ALSO huge, rather than embedding it raw", async () => {
    const huge = Buffer.alloc(3 * 1024 * 1024, 0x41);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => huge.buffer.slice(huge.byteOffset, huge.byteOffset + huge.byteLength),
    } as unknown as Response);
    const { deliverBlogHtml } = await import("../deliver-html");
    await deliverBlogHtml(CTX, INPUT);
    const html = uploadedHtml();
    expect(html).not.toContain("base64,");
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(1024 * 1024);
  });
});
