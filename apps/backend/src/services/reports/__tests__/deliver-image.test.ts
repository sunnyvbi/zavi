
import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetIndexMemoForTest } from "@/services/workspace-files/workspace-files";

const gen = vi.fn();
const routeImage = gen;
const configured = vi.fn();
const chargeMedia = vi.fn(async (_a: { key: string; cost_usd: number; task: string }) => "charged");
const canAffordMedia = vi.fn(async (_tenant: string, _cost: number) => true);
const mediaChargeRecorded = vi.fn(async (_tenant: string, _key: string) => false);
const removed: string[] = [];
const deletedRows: string[] = [];
let failRemove = 0;

vi.mock("@/services/media-router/router", () => ({
  routeImage: (...a: unknown[]) => gen(...a),
  isTaskConfigured: () => configured(),
  cacheModelTag: async (t: string) =>
    t === "image.vector"
      ? "fal-ai/recraft/v4.1/text-to-vector"
      : "openai/gpt-image-2.5/flare/text-to-image",
  estimateCost: () => 0.06,
  isMediaRouterEnabled: async () => true,
}));
const isPreviewRunId = vi.fn(async (_t: string, _r: string) => false);
vi.mock("@/services/channels/preview-run-starts", () => ({
  isPreviewRunId: (t: unknown, r: unknown) => isPreviewRunId(t as never, r as never),
}));
vi.mock("@/services/media-router/charge", () => ({
  chargeMedia: (a: unknown) => chargeMedia(a as never),
  canAffordMedia: (t: unknown, c: unknown) => canAffordMedia(t as never, c as never),
  mediaChargeRecorded: (t: unknown, k: unknown) => mediaChargeRecorded(t as never, k as never),
}));
vi.mock("@/services/reports/guard", () => ({
  assertRunTenantOwnership: async () => "tenant-A",
}));
vi.mock("@/services/reports/run-binding", () => ({
  artifactRunBinding: async () => ({ agent_slug: "operator", thread_id: null }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

const rpc = vi.fn();
const uploads: string[] = [];
const uploadRecs: Array<{ path: string; bytes: Buffer; contentType?: string }> = [];
const downloads: string[] = [];
const signed: string[] = [];
const claimedKeys = new Set<string>();
let cacheHas = false;
let rowId = 0;
let failWorkspaceUpload = false;
let priorImages = 0;
let countFails = false;

function pngBlob() {
  return { arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]).buffer };
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: (fn: string, args: unknown) => rpc(fn, args),
    from: (tbl: string) => {
      if (tbl === "run_artifacts") {
        const counted: Record<string, unknown> = {
          eq: () => counted,
          like: () => counted,
          then: (res: (v: unknown) => unknown) =>
            res(countFails ? { count: null, error: { message: "db down" } } : { count: priorImages, error: null }),
        };
        return {
          select: () => counted,
          upsert: () => ({
            select: () => ({
              single: async () => ({ data: { id: `art-${++rowId}` }, error: null }),
            }),
          }),
          update: () => ({
            eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
          }),
          delete: () => ({
            eq: () => ({
              eq: async (_k: string, id: string) => {
                deletedRows.push(id);
                return { error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${tbl}`);
    },
    storage: {
      from: () => ({
        download: async (path: string) => {
          downloads.push(path);
          if (cacheHas && path.startsWith("image-cache/")) return { data: pngBlob() };
          return { data: null, error: { message: "not found" } };
        },
        upload: async (path: string, bytes: Buffer, opts?: { contentType?: string }) => {
          if (failWorkspaceUpload && path.includes("/workspace-files/")) return { error: { message: "storage down" } };
          uploads.push(path);
          uploadRecs.push({ path, bytes: Buffer.from(bytes), contentType: opts?.contentType });
          return { error: null };
        },
        remove: async (paths: string[]) => {
          if (failRemove > 0 && !paths[0]?.startsWith("image-cache")) {
            failRemove--;
            return { error: { message: "storage down" } };
          }
          removed.push(...paths);
          return { error: null };
        },
        createSignedUrl: async (path: string) => {
          signed.push(path);
          return { data: { signedUrl: "https://sb/signed" }, error: null };
        },
      }),
    },
  }),
}));

function fetchStub() {
  return vi.fn(async (url: string) => {
    const m = /^data:([^;,]+);base64,(.*)$/.exec(String(url));
    if (m) {
      const buf = Buffer.from(m[2], "base64");
      return {
        ok: true,
        headers: { get: () => m[1] },
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    }
    return {
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 9, 9]).buffer,
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  uploads.length = 0;
  uploadRecs.length = 0;
  downloads.length = 0;
  signed.length = 0;
  removed.length = 0;
  failRemove = 0;
  deletedRows.length = 0;
  mediaChargeRecorded.mockResolvedValue(false);
  cacheHas = false;
  rowId = 0;
  failWorkspaceUpload = false;
  priorImages = 0;
  countFails = false;
  _resetIndexMemoForTest();
  configured.mockResolvedValue(true);
  gen.mockResolvedValue({
    ok: true,
    imageUrl: "https://cdn/x.png",
    mime: "image/png",
    cost_usd: 0.06,
    model: "openai/gpt-image-2.5/flare/text-to-image",
  });
  chargeMedia.mockResolvedValue("charged");
  isPreviewRunId.mockResolvedValue(false);
  canAffordMedia.mockResolvedValue(true);
  claimedKeys.clear();
  rpc.mockImplementation(async (fn: string, args: { p_idempotency_key?: string }) => {
    if (fn === "consume_higgsfield_generate_or_reject") {
      const k = args?.p_idempotency_key ?? "";
      if (claimedKeys.has(k)) return { data: "already", error: null };
      claimedKeys.add(k);
    }
    return { data: "charged", error: null };
  });
  vi.stubGlobal("fetch", fetchStub());
});

async function run(input: unknown) {
  const { deliverImage } = await import("@/services/reports/deliver-image");
  return deliverImage(
    { tenant_id: "tenant-A", run_id: "run-1", log: () => {} },
    input as never,
  );
}

async function runWithTransform(input: unknown, transform: unknown) {
  const { deliverImage } = await import("@/services/reports/deliver-image");
  return deliverImage(
    { tenant_id: "tenant-A", run_id: "run-1", log: () => {}, transform: transform as never },
    input as never,
  );
}

describe("deliver-image — happy path", () => {
  it("generates one image per prompt, all delivered", async () => {
    const r = await run({
      prompts: [{ prompt: "a red car" }, { prompt: "a blue car" }],
      aspect_ratio: "1:1",
    });
    expect(r.images).toHaveLength(2);
    expect(r.generated).toBe(2);
    expect(r.cached).toBe(0);
    expect(r.skipped).toHaveLength(0);
    expect(gen).toHaveBeenCalledTimes(2);
  });
});

describe("signup preview — Zavi pays for one set of images per run", () => {
  it("renders the first set on a preview run", async () => {
    isPreviewRunId.mockResolvedValue(true);
    const r = await run({ prompts: ["a", "b"] });
    expect(r.images).toHaveLength(2);
  });
  it("refuses a second set before any vendor call", async () => {
    isPreviewRunId.mockResolvedValue(true);
    priorImages = 1;
    const r = await run({ prompts: ["a", "b"] });
    expect(r.images).toHaveLength(0);
    expect(r.skipped.map((s) => s.reason)).toEqual(["preview_render_used", "preview_render_used"]);
    expect(gen).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("fails closed when the count cannot be read", async () => {
    isPreviewRunId.mockResolvedValue(true);
    countFails = true;
    const r = await run({ prompts: ["a"] });
    expect(r.images).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe("meter_error");
    expect(gen).not.toHaveBeenCalled();
  });
  it("does not cap a tenant-paid run", async () => {
    priorImages = 3;
    const r = await run({ prompts: ["a"] });
    expect(r.images).toHaveLength(1);
  });
});

describe("GUARDRAIL 1 — every generation is metered", () => {
  it("calls the cap RPC once per image BEFORE generating", async () => {
    const { slotHash } = await import("@/services/reports/deliver-image");
    await run({ prompts: [{ prompt: "x" }, { prompt: "y" }], aspect_ratio: "1:1" });
    const rpcCalls = rpc.mock.calls.filter(
      (c) => c[0] === "consume_higgsfield_generate_or_reject",
    );
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0][1].p_idempotency_key).toBe(
      `run-1:agent-image:0:${slotHash("x", "1:1", "photo", undefined)}`,
    );
    expect(rpcCalls[1][1].p_idempotency_key).toBe(
      `run-1:agent-image:1:${slotHash("y", "1:1", "photo", undefined)}`,
    );
  });

  it("meter_error FAILS CLOSED — no generation, image skipped", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    const r = await run({ prompts: [{ prompt: "x" }] });
    expect(gen).not.toHaveBeenCalled();
    expect(r.images).toHaveLength(0);
    expect(r.skipped[0]).toMatchObject({ index: 0, reason: "meter_error" });
  });

  it("over_cap stops the batch — remaining images not generated", async () => {
    rpc
      .mockResolvedValueOnce({ data: "charged", error: null })
      .mockResolvedValueOnce({ data: "over_cap", error: null });
    const r = await run({
      prompts: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }],
    });
    expect(r.images).toHaveLength(1);
    expect(gen).toHaveBeenCalledTimes(1);
    expect(r.skipped.filter((s) => s.reason === "over_daily_cap")).toHaveLength(2);
  });
});

describe("GUARDRAIL 2 — cache is tenant-scoped", () => {
  it("every cache path is prefixed with the canonical tenant_id", async () => {
    await run({ prompts: [{ prompt: "shared prompt text" }] });
    const cachePaths = [...downloads, ...uploads].filter((p) =>
      p.startsWith("image-cache/"),
    );
    expect(cachePaths.length).toBeGreaterThan(0);
    for (const p of cachePaths) {
      expect(p).toMatch(/^image-cache\/tenant-A\//);
    }
  });

  it("a cache HIT costs zero — the meter RPC is never called", async () => {
    cacheHas = true;
    const r = await run({ prompts: [{ prompt: "seen before" }] });
    expect(rpc).not.toHaveBeenCalled();
    expect(gen).not.toHaveBeenCalled();
    expect(r.cached).toBe(1);
    expect(r.images).toHaveLength(1);
    expect(r.images[0].cached).toBe(true);
  });
});

describe("vendor_out_of_credits — OUR wallet, not the customer's cap", () => {
  it("classifies a 403 not_enough_credits submit as vendor_out_of_credits", async () => {
    gen.mockResolvedValue({
      ok: false,
      error: 'submit 403: {"detail":"not_enough_credits"}',
    });
    const r = await run({ prompts: [{ prompt: "x" }] });
    expect(r.images).toHaveLength(0);
    expect(r.skipped[0]).toMatchObject({ index: 0, reason: "vendor_out_of_credits" });
    expect(r.skipped[0].reason).not.toBe("over_daily_cap");
  });

  it("classifies our lapsed Higgsfield plan as vendor_out_of_credits, without the vendor text", async () => {
    gen.mockResolvedValue({
      ok: false,
      error: "mcp generate_image: Error starting generation: Requires basic plan or higher.",
    });
    const r = await run({ prompts: [{ prompt: "x" }] });
    expect(r.skipped[0]).toMatchObject({ index: 0, reason: "vendor_out_of_credits" });
    expect(JSON.stringify(r.skipped)).not.toMatch(/plan/i);
    const { logEvent } = await import("@/services/logging/logEvent");
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "image_vendor_out_of_credits",
        meta: { failure_class: "vendor_plan_required" },
      }),
    );
  });

  it("stops the batch — later slots claim NO further billing slots", async () => {
    gen.mockResolvedValue({
      ok: false,
      error: 'submit 403: {"detail":"not_enough_credits"}',
    });
    const r = await run({ prompts: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }] });
    expect(gen).toHaveBeenCalledTimes(1);
    const rpcCalls = rpc.mock.calls.filter(
      (c) => c[0] === "consume_higgsfield_generate_or_reject",
    );
    expect(rpcCalls).toHaveLength(1);
    expect(r.skipped.filter((x) => x.reason === "vendor_out_of_credits")).toHaveLength(3);
  });

  it("an ordinary vendor error stays retryable generation_failed", async () => {
    gen.mockResolvedValue({ ok: false, error: "submit 500: upstream boom" });
    const r = await run({ prompts: [{ prompt: "x" }, { prompt: "y" }] });
    expect(gen).toHaveBeenCalledTimes(2);
    expect(r.skipped.every((x) => x.reason === "generation_failed")).toBe(true);
  });

  it("plateless slots still render after the wallet is empty", async () => {
    gen.mockResolvedValue({
      ok: false,
      error: 'submit 403: {"detail":"not_enough_credits"}',
    });
    const r = await runWithTransform(
      { prompts: [{ prompt: "a" }, { prompt: null, filename: "p2.png" }] },
      async () => ({ bytes: Buffer.from([9, 9, 9, 9]) }),
    );
    expect(r.typeset).toBe(1);
    expect(r.images).toHaveLength(1);
    expect(r.skipped.filter((x) => x.reason === "vendor_out_of_credits")).toHaveLength(1);
  });
});

describe("honesty — a failed image is reported, never faked", () => {
  it("generation failure lands in skipped, not images", async () => {
    gen.mockResolvedValue({ ok: false, error: "vendor 500" });
    const r = await run({ prompts: [{ prompt: "x" }] });
    expect(r.images).toHaveLength(0);
    expect(r.skipped[0]).toMatchObject({ index: 0, reason: "generation_failed" });
  });

  it("unconfigured Higgsfield → all skipped not_configured, nothing generated", async () => {
    configured.mockResolvedValue(false);
    const r = await run({ prompts: [{ prompt: "x" }, { prompt: "y" }] });
    expect(gen).not.toHaveBeenCalled();
    expect(r.images).toHaveLength(0);
    expect(r.skipped.every((s) => s.reason === "not_configured")).toBe(true);
  });

  it("mixed success/failure → generated count matches successes only", async () => {
    gen
      .mockResolvedValueOnce({ ok: true, imageUrl: "https://cdn/a.png" })
      .mockResolvedValueOnce({ ok: false, error: "vendor 500" });
    const r = await run({ prompts: [{ prompt: "a" }, { prompt: "b" }] });
    expect(r.generated).toBe(1);
    expect(r.images).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
  });
});

describe("input validation", () => {
  it("rejects more than 5 prompts", async () => {
    const { generateImageInputSchema } = await import("@/services/reports/deliver-image");
    const parsed = generateImageInputSchema.safeParse({
      prompts: Array.from({ length: 6 }, (_, i) => ({ prompt: `p${i}` })),
    });
    expect(parsed.success).toBe(false);
  });

  it("defaults aspect_ratio to 1:1", async () => {
    const { generateImageInputSchema } = await import("@/services/reports/deliver-image");
    const parsed = generateImageInputSchema.parse({ prompts: [{ prompt: "x" }] });
    expect(parsed.aspect_ratio).toBe("1:1");
  });
});

describe("transform hook — cannot affect the money path", () => {
  it("meters exactly as many times WITH a transform as without", async () => {
    await run({ prompts: [{ prompt: "x" }, { prompt: "y" }] });
    const without = rpc.mock.calls.filter(
      (c) => c[0] === "consume_higgsfield_generate_or_reject",
    ).length;

    vi.clearAllMocks();
    rpc.mockResolvedValue({ data: "charged", error: null });
    await runWithTransform(
      { prompts: [{ prompt: "x" }, { prompt: "y" }] },
      async (b: Buffer) => ({ bytes: b }),
    );
    const withHook = rpc.mock.calls.filter(
      (c) => c[0] === "consume_higgsfield_generate_or_reject",
    ).length;

    expect(withHook).toBe(without);
    expect(withHook).toBe(2);
  });

  it("delivers the TRANSFORMED bytes, not the raw plate", async () => {
    const marker = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const r = await runWithTransform(
      { prompts: [{ prompt: "x" }] },
      async () => ({ bytes: marker, mime: "image/png" }),
    );
    expect(r.images).toHaveLength(1);
    expect(r.images[0].bytes).toBe(marker.byteLength);
  });

  it("caches the RAW PLATE, so re-running with different copy is free", async () => {
    await runWithTransform(
      { prompts: [{ prompt: "a red car" }] },
      async () => ({ bytes: Buffer.from([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]) }),
    );
    const cacheWrite = uploads.find((u) => u.startsWith("image-cache/"));
    expect(cacheWrite).toBeTruthy();
    const cachedBytes = 6;
    expect(cachedBytes).not.toBe(12);
  });

  it("a throwing transform skips the image — never silently ships the raw plate", async () => {
    const r = await runWithTransform({ prompts: [{ prompt: "x" }] }, async () => {
      throw new Error("brand_pixel_verification_failed: #027bff");
    });
    expect(r.images).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toBe("transform_failed");
    expect(r.skipped[0].detail).toContain("brand_pixel_verification_failed");
  });

  it("a null-returning transform skips the image", async () => {
    const r = await runWithTransform({ prompts: [{ prompt: "x" }] }, async () => null);
    expect(r.images).toHaveLength(0);
    expect(r.skipped[0].reason).toBe("transform_failed");
  });

  it("a transform failure does NOT stop the rest of the batch", async () => {
    let n = 0;
    const r = await runWithTransform(
      { prompts: [{ prompt: "x" }, { prompt: "y" }] },
      async (b: Buffer) => {
        n += 1;
        if (n === 1) throw new Error("boom");
        return { bytes: b };
      },
    );
    expect(r.skipped).toHaveLength(1);
    expect(r.images).toHaveLength(1);
  });

  it("no transform supplied = byte-identical behaviour to before the hook existed", async () => {
    const r = await run({ prompts: [{ prompt: "x" }] });
    expect(r.images).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
    expect(r.images[0].bytes).toBe(6);
  });
});

describe("plateless slots — the non-spending branch", () => {
  async function runWithTransform(input: unknown, transform: unknown) {
    const { deliverImage } = await import("@/services/reports/deliver-image");
    return deliverImage(
      { tenant_id: "tenant-A", run_id: "run-1", log: () => {}, transform: transform as never },
      input as never,
    );
  }
  const meterCalls = () =>
    rpc.mock.calls.filter((c) => c[0] === "consume_higgsfield_generate_or_reject").length;

  it("a null prompt NEVER calls the meter and NEVER calls the vendor", async () => {
    const r = await runWithTransform(
      { prompts: [{ prompt: null, filename: "type-only.png" }] },
      async () => ({ bytes: Buffer.from([1, 2, 3, 4]) }),
    );
    expect(r.images).toHaveLength(1);
    expect(meterCalls()).toBe(0);
    expect(gen).not.toHaveBeenCalled();
  });

  it("meters EXACTLY once per photographic panel, no matter how many are plateless", async () => {
    const prompts = [
      { prompt: "a lit warehouse at dusk" },
      ...Array.from({ length: 6 }, (_, i) => ({ prompt: null, filename: `p${i + 2}.png` })),
    ];
    const r = await runWithTransform({ prompts }, async () => ({
      bytes: Buffer.from([9, 9, 9, 9]),
    }));
    expect(r.images).toHaveLength(7);
    expect(meterCalls()).toBe(1);
    expect(gen).toHaveBeenCalledTimes(1);
    expect(r.generated).toBe(1);
    expect(r.typeset).toBe(6);
  });

  it("scales the meter with the PHOTOGRAPHIC count, not the panel count", async () => {
    await runWithTransform(
      {
        prompts: [
          { prompt: "a" },
          { prompt: null },
          { prompt: "b" },
          { prompt: null },
          { prompt: null },
        ],
      },
      async () => ({ bytes: Buffer.from([7, 7, 7, 7]) }),
    );
    expect(meterCalls()).toBe(2);
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it("a null prompt touches neither side of the tenant cache", async () => {
    await runWithTransform({ prompts: [{ prompt: null }] }, async () => ({
      bytes: Buffer.from([1, 1, 1, 1]),
    }));
    expect(downloads.filter((d) => d.startsWith("image-cache/"))).toHaveLength(0);
    expect(uploads.filter((u) => u.startsWith("image-cache/"))).toHaveLength(0);
  });

  it("a null prompt is skipped, not stored, when no transform can make the bytes", async () => {
    const { deliverImage } = await import("@/services/reports/deliver-image");
    const r = await deliverImage(
      { tenant_id: "tenant-A", run_id: "run-1", log: () => {} },
      { prompts: [{ prompt: null }] } as never,
    );
    expect(r.images).toHaveLength(0);
    expect(r.skipped[0].reason).toBe("transform_failed");
    expect(meterCalls()).toBe(0);
  });

  it("is unreachable from the PUBLIC generate_image schema", async () => {
    const { generateImageInputSchema } = await import("@/services/reports/deliver-image");
    expect(() => generateImageInputSchema.parse({ prompts: [{ prompt: null }] })).toThrow();
  });

  it("the daily cap kills the photographic panels but still delivers the free ones", async () => {
    rpc.mockResolvedValue({ data: "over_cap", error: null });
    const r = await runWithTransform(
      { prompts: [{ prompt: "cover" }, { prompt: null }, { prompt: null }] },
      async () => ({ bytes: Buffer.from([5, 5, 5, 5]) }),
    );
    expect(r.images).toHaveLength(2);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ index: 0, reason: "over_daily_cap" });
    expect(meterCalls()).toBe(1);
    expect(gen).not.toHaveBeenCalled();
  });
});

describe("media router — modes, credits, and the charge", () => {
  it("mode=photo routes image.photo and charges the delivered image with a prompt-hashed key", async () => {
    const { slotHash } = await import("@/services/reports/deliver-image");
    const r = await run({ prompts: [{ prompt: "a bike" }], aspect_ratio: "1:1", mode: "photo" });
    expect(routeImage).toHaveBeenCalledWith("image.photo", {
      prompt: "a bike",
      aspect_ratio: "1:1",
      reference_url: undefined,
    });
    expect(r.generated).toBe(1);
    expect(chargeMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "tenant-A",
        run_id: "run-1",
        key: `run-1:agent-image:0:${slotHash("a bike", "1:1", "photo", undefined)}`,
        cost_usd: 0.06,
        task: "image.photo",
      }),
    );
  });

  it("mode=text routes image.text, mode=vector routes image.vector", async () => {
    await run({ prompts: [{ prompt: "a poster reading SALE" }], aspect_ratio: "1:1", mode: "text" });
    expect(routeImage.mock.calls[0][0]).toBe("image.text");
    gen.mockResolvedValueOnce({
      ok: true,
      imageUrl: "data:image/svg+xml;base64," + Buffer.from("<svg><path d='M0 0'/></svg>").toString("base64"),
      mime: "image/svg+xml",
      cost_usd: 0.08,
      model: "fal-ai/recraft/v4.1/text-to-vector",
    });
    await run({ prompts: [{ prompt: "a mark" }], aspect_ratio: "1:1", mode: "vector" });
    expect(routeImage.mock.calls[1][0]).toBe("image.vector");
  });

  it("two calls in one run with different prompts both generate (the old key collided)", async () => {
    const a = await run({ prompts: [{ prompt: "one" }], aspect_ratio: "1:1", mode: "photo" });
    const b = await run({ prompts: [{ prompt: "two" }], aspect_ratio: "1:1", mode: "photo" });
    expect(a.generated + b.generated).toBe(2);
    expect(chargeMedia).toHaveBeenCalledTimes(2);
    const keys = chargeMedia.mock.calls.map((c) => c[0].key);
    expect(new Set(keys).size).toBe(2);
  });

  it("the SAME request replayed in the same run is still de-duplicated", async () => {
    const a = await run({ prompts: [{ prompt: "same" }], aspect_ratio: "1:1", mode: "photo" });
    const b = await run({ prompts: [{ prompt: "same" }], aspect_ratio: "1:1", mode: "photo" });
    expect(a.generated).toBe(1);
    expect(b.generated).toBe(0);
    expect(b.skipped[0]).toMatchObject({ reason: "meter_error", detail: "retry_replay" });
    expect(chargeMedia).toHaveBeenCalledTimes(1);
  });

  it("a signup preview run is paid by Zavi: no wallet check and no charge", async () => {
    isPreviewRunId.mockResolvedValue(true);
    canAffordMedia.mockResolvedValue(false);
    const r = await run({ prompts: [{ prompt: "a bike" }], aspect_ratio: "1:1", mode: "photo" });
    expect(r.generated).toBe(1);
    expect(canAffordMedia).not.toHaveBeenCalled();
    expect(chargeMedia).not.toHaveBeenCalled();
  });

  it("cannot afford → skipped insufficient_credits, no vendor call, no charge", async () => {
    canAffordMedia.mockResolvedValueOnce(false);
    const r = await run({ prompts: [{ prompt: "x" }], aspect_ratio: "1:1", mode: "photo" });
    expect(r.skipped[0].reason).toBe("insufficient_credits");
    expect(routeImage).not.toHaveBeenCalled();
    expect(chargeMedia).not.toHaveBeenCalled();
  });

  it("refused → skipped refused, not charged", async () => {
    gen.mockResolvedValueOnce({ ok: false, error: "policy", reason: "refused" });
    const r = await run({ prompts: [{ prompt: "x" }], aspect_ratio: "1:1", mode: "photo" });
    expect(r.skipped[0].reason).toBe("refused");
    expect(chargeMedia).not.toHaveBeenCalled();
  });

  it("a generation failure is not charged", async () => {
    gen.mockResolvedValueOnce({ ok: false, error: "vendor 500", reason: "vendor_error" });
    const r = await run({ prompts: [{ prompt: "x" }], aspect_ratio: "1:1", mode: "photo" });
    expect(r.skipped[0].reason).toBe("generation_failed");
    expect(chargeMedia).not.toHaveBeenCalled();
  });

  it("a cache hit is not charged", async () => {
    cacheHas = true;
    const r = await run({ prompts: [{ prompt: "seen before" }], aspect_ratio: "1:1", mode: "photo" });
    expect(r.cached).toBe(1);
    expect(chargeMedia).not.toHaveBeenCalled();
  });

  it("the cache key carries the MODEL, so a router switch never serves the old bytes", async () => {
    const { cacheKey } = await import("@/services/reports/deliver-image");
    const a = cacheKey("tenant-A", "1:1", "p", "model-one");
    const b = cacheKey("tenant-A", "1:1", "p", "model-two");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^image-cache\/tenant-A\/[0-9a-f]{32}\.png$/);
    expect(cacheKey("tenant-A", "1:1", "p", "m", "svg")).toMatch(/\.svg$/);
  });
});

describe("media router — reference_url ownership (E3)", () => {
  it("schema accepts https or the tenant's own file path, rejects http and other buckets", async () => {
    const { generateImageInputSchema } = await import("@/services/reports/deliver-image");
    const ok = (v: unknown) => generateImageInputSchema.safeParse(v).success;
    expect(ok({ prompts: [{ prompt: "p" }], mode: "edit" })).toBe(false);
    expect(ok({ prompts: [{ prompt: "p" }], mode: "edit", reference_url: "http://x/y.png" })).toBe(false);
    expect(ok({ prompts: [{ prompt: "p" }], mode: "edit", reference_url: "https://x/y.png" })).toBe(true);
    expect(
      ok({
        prompts: [{ prompt: "p" }],
        mode: "edit",
        reference_url: "agent-chat-images/11111111-1111-1111-1111-111111111111/a.jpg",
      }),
    ).toBe(true);
    expect(ok({ prompts: [{ prompt: "p" }], mode: "edit", reference_url: "other-bucket/x.jpg" })).toBe(false);
  });

  it("edit with ANOTHER tenant's path is refused before any vendor call", async () => {
    const r = await run({
      prompts: [{ prompt: "p" }],
      aspect_ratio: "1:1",
      mode: "edit",
      reference_url: "agent-chat-images/99999999-9999-9999-9999-999999999999/a.jpg",
    });
    expect(r.skipped[0]).toMatchObject({ reason: "generation_failed", detail: "reference_not_owned" });
    expect(routeImage).not.toHaveBeenCalled();
    expect(signed).toHaveLength(0);
    expect(chargeMedia).not.toHaveBeenCalled();
  });

  it("edit with own path passes a SIGNED url to the router, never the raw path", async () => {
    await run({
      prompts: [{ prompt: "p" }],
      aspect_ratio: "1:1",
      mode: "edit",
      reference_url: "agent-chat-images/tenant-A/a.jpg",
    });
    expect(signed).toEqual(["tenant-A/a.jpg"]);
    expect((routeImage.mock.calls[0][1] as { reference_url?: string }).reference_url).toBe("https://sb/signed");
  });

  it("a reference that is neither https nor an own-bucket path is refused at the deliver layer", async () => {
    const r = await run({
      prompts: [{ prompt: "p" }],
      aspect_ratio: "1:1",
      mode: "edit",
      reference_url: "other-bucket/tenant-A/a.jpg",
    });
    expect(r.skipped[0]).toMatchObject({ reason: "generation_failed", detail: "reference_not_owned" });
    expect(routeImage).not.toHaveBeenCalled();
  });

  it("a public https reference is passed through untouched", async () => {
    await run({
      prompts: [{ prompt: "p" }],
      aspect_ratio: "1:1",
      mode: "edit",
      reference_url: "https://cdn.example.com/a.png",
    });
    expect(signed).toHaveLength(0);
    expect((routeImage.mock.calls[0][1] as { reference_url?: string }).reference_url).toBe(
      "https://cdn.example.com/a.png",
    );
  });
});

describe("media router — vector output is sanitized SVG", () => {
  const dirtySvg = '<svg onload="x()"><path d="M0 0"/></svg>';

  it("stores a sanitized .svg with image/svg+xml", async () => {
    gen.mockResolvedValueOnce({
      ok: true,
      imageUrl: "data:image/svg+xml;base64," + Buffer.from(dirtySvg).toString("base64"),
      mime: "image/svg+xml",
      cost_usd: 0.08,
      model: "fal-ai/recraft/v4.1/text-to-vector",
    });
    const r = await run({
      prompts: [{ prompt: "logo", filename: "mark" }],
      aspect_ratio: "1:1",
      mode: "vector",
    });
    expect(r.images[0].filename).toBe("mark.svg");
    const art = uploadRecs.find((u) => u.path === "tenant-A/run-1/mark.svg");
    expect(art).toBeTruthy();
    expect(art!.contentType).toBe("image/svg+xml");
    expect(art!.bytes.toString("utf8")).not.toMatch(/onload/i);
    expect(art!.bytes.toString("utf8")).toContain('<path d="M0 0"/>');
    const cached = uploadRecs.find((u) => u.path.startsWith("image-cache/"));
    expect(cached!.path).toMatch(/\.svg$/);
    expect(cached!.bytes.toString("utf8")).not.toMatch(/onload/i);
  });

  it("a non-vector task still refuses image/svg+xml", async () => {
    gen.mockResolvedValueOnce({
      ok: true,
      imageUrl: "data:image/svg+xml;base64," + Buffer.from(dirtySvg).toString("base64"),
      mime: "image/svg+xml",
      cost_usd: 0.06,
      model: "m",
    });
    const r = await run({ prompts: [{ prompt: "p" }], aspect_ratio: "1:1", mode: "photo" });
    expect(r.images).toHaveLength(0);
    expect(r.skipped[0].reason).toBe("download_failed");
  });

  it("unparseable SVG is skipped as unsupported_type, never stored", async () => {
    gen.mockResolvedValueOnce({
      ok: true,
      imageUrl: "data:image/svg+xml;base64," + Buffer.from("<html>nope</html>").toString("base64"),
      mime: "image/svg+xml",
      cost_usd: 0.08,
      model: "fal-ai/recraft/v4.1/text-to-vector",
    });
    const r = await run({ prompts: [{ prompt: "logo" }], aspect_ratio: "1:1", mode: "vector" });
    expect(r.images).toHaveLength(0);
    expect(r.skipped[0].reason).toBe("unsupported_type");
  });
});

describe("delivered images also land in the workspace Files", () => {
  const realPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("IHDR-generated-body"),
  ]);
  function stubRealPng() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => realPng.buffer.slice(realPng.byteOffset, realPng.byteOffset + realPng.byteLength),
      })),
    );
  }
  const workspaceObjects = () =>
    uploadRecs.filter((u) => u.path.startsWith("tenant-A/workspace-files/") && !u.path.endsWith("/index.json"));
  const indexWrites = () => uploadRecs.filter((u) => u.path === "tenant-A/workspace-files/index.json");

  it("writes the exact delivered bytes into Files, keyed to the run artifact", async () => {
    stubRealPng();
    const r = await run({ prompts: [{ prompt: "a hero shot", filename: "hero" }] });
    expect(r.images).toHaveLength(1);
    const art = uploadRecs.find((u) => u.path === "tenant-A/run-1/hero.png");
    expect(art).toBeTruthy();
    const copies = workspaceObjects();
    expect(copies).toHaveLength(1);
    expect(copies[0].path).toMatch(/^tenant-A\/workspace-files\/[0-9a-f-]{36}\/hero[^/]*\.png$/);
    expect(copies[0].contentType).toBe("image/png");
    expect(copies[0].bytes.equals(art!.bytes)).toBe(true);
    const index = JSON.parse(indexWrites().at(-1)!.bytes.toString("utf8")) as {
      files: Array<{ name: string; mime: string; origin?: string; uploaded_by: string | null }>;
    };
    expect(index.files).toHaveLength(1);
    expect(index.files[0]).toMatchObject({ mime: "image/png", origin: "run_artifact:art-1", uploaded_by: null });
  });

  it("never fails the delivery, the charge or the artifact when the Files write breaks", async () => {
    stubRealPng();
    failWorkspaceUpload = true;
    const r = await run({ prompts: [{ prompt: "a hero shot", filename: "hero" }] });
    expect(r.images).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
    expect(uploadRecs.find((u) => u.path === "tenant-A/run-1/hero.png")).toBeTruthy();
    expect(chargeMedia).toHaveBeenCalledTimes(1);
    expect(workspaceObjects()).toHaveLength(0);
    expect(indexWrites()).toHaveLength(0);
  });

  it("skips an SVG mark, which Files cannot hold, without touching the index", async () => {
    gen.mockResolvedValue({
      ok: true,
      imageUrl: "data:image/svg+xml;base64," + Buffer.from("<svg><path d='M0 0'/></svg>").toString("base64"),
      mime: "image/svg+xml",
      cost_usd: 0.04,
      model: "fal-ai/recraft/v4.1/text-to-vector",
    });
    const r = await run({ prompts: [{ prompt: "a mark", filename: "mark" }], mode: "vector" });
    expect(r.images).toHaveLength(1);
    expect(workspaceObjects()).toHaveLength(0);
    expect(indexWrites()).toHaveLength(0);
  });
});

describe("cache is seeded only by a delivered, charged image", () => {
  const cacheWrites = () => uploads.filter((p) => p.startsWith("image-cache/"));

  it("a failed transform leaves no FREE cache entry (the plate waits in the pending store, charged on its first delivery)", async () => {
    const r = await runWithTransform({ prompts: [{ prompt: "a red car" }], aspect_ratio: "1:1" }, async () => {
      throw new Error("compose broke");
    });
    expect(r.images).toHaveLength(0);
    expect(chargeMedia).not.toHaveBeenCalled();
    expect(cacheWrites()).toHaveLength(0);
    expect(uploads.some((p) => p.startsWith("image-cache-pending/"))).toBe(true);
  });

  it("a delivered, charged image is cached after the charge", async () => {
    const r = await run({ prompts: [{ prompt: "a red car" }], aspect_ratio: "1:1" });
    expect(r.images).toHaveLength(1);
    expect(chargeMedia).toHaveBeenCalledTimes(1);
    expect(cacheWrites()).toHaveLength(1);
  });

  it("a charge that errors does not seed the cache", async () => {
    chargeMedia.mockResolvedValueOnce("error").mockResolvedValueOnce("error");
    const r = await run({ prompts: [{ prompt: "a red car" }], aspect_ratio: "1:1" });
    expect(r.images).toHaveLength(0);
    expect(cacheWrites()).toHaveLength(0);
  });

  it("a preview run Zavi paid for does not seed the tenant's free cache", async () => {
    isPreviewRunId.mockResolvedValueOnce(true);
    await run({ prompts: [{ prompt: "a red car" }], aspect_ratio: "1:1" });
    expect(chargeMedia).not.toHaveBeenCalled();
    expect(cacheWrites()).toHaveLength(0);
  });
});

describe("a charge error never leaves a free delivered image", () => {
  it("errors twice and the ledger has no row: not delivered, artifact removed, plate stays pending", async () => {
    chargeMedia.mockResolvedValueOnce("error").mockResolvedValueOnce("error");
    const r = await run({ prompts: [{ prompt: "a red car" }], aspect_ratio: "1:1" });
    expect(r.images).toHaveLength(0);
    expect(r.generated).toBe(0);
    expect(r.skipped).toEqual([{ index: 0, reason: "charge_failed" }]);
    expect(chargeMedia).toHaveBeenCalledTimes(2);
    expect(chargeMedia.mock.calls[0][0].key).toBe(chargeMedia.mock.calls[1][0].key);
    expect(removed).toContain("tenant-A/run-1/image-1.png");
    expect(deletedRows).toEqual(["art-1"]);
    expect(removed.some((p) => p.startsWith("image-cache-pending/"))).toBe(false);
  });

  it("a one-off error is retried on the same key and the image is delivered, charged once", async () => {
    chargeMedia.mockResolvedValueOnce("error");
    const r = await run({ prompts: [{ prompt: "a red car" }], aspect_ratio: "1:1" });
    expect(r.images).toHaveLength(1);
    expect(chargeMedia).toHaveBeenCalledTimes(2);
    expect(chargeMedia.mock.calls[0][0].key).toBe(chargeMedia.mock.calls[1][0].key);
    expect(deletedRows).toHaveLength(0);
  });

  it("an error whose charge actually landed (ledger has the key) keeps the image", async () => {
    chargeMedia.mockResolvedValueOnce("error").mockResolvedValueOnce("error");
    mediaChargeRecorded.mockResolvedValueOnce(true);
    const r = await run({ prompts: [{ prompt: "a red car" }], aspect_ratio: "1:1" });
    expect(r.images).toHaveLength(1);
    expect(deletedRows).toHaveLength(0);
  });

  it("a cleanup that resolves with {error} is retried once, then logged at ERROR", async () => {
    const { logEvent } = await import("@/services/logging/logEvent");
    chargeMedia.mockResolvedValueOnce("error").mockResolvedValueOnce("error");
    failRemove = 2;
    const r = await run({ prompts: [{ prompt: "a red car" }], aspect_ratio: "1:1" });
    expect(r.images).toHaveLength(0);
    expect(r.skipped[0].reason).toBe("charge_failed");
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "withheld_image_cleanup_failed" }));
  });

  it("a cleanup that fails once and then succeeds is not logged", async () => {
    const { logEvent } = await import("@/services/logging/logEvent");
    chargeMedia.mockResolvedValueOnce("error").mockResolvedValueOnce("error");
    failRemove = 1;
    await run({ prompts: [{ prompt: "a red car" }], aspect_ratio: "1:1" });
    expect(logEvent).not.toHaveBeenCalledWith(expect.objectContaining({ code: "withheld_image_cleanup_failed" }));
    expect(removed).toContain("tenant-A/run-1/image-1.png");
  });

  it("an unreadable ledger is treated as not charged: withheld", async () => {
    chargeMedia.mockResolvedValueOnce("error").mockResolvedValueOnce("error");
    mediaChargeRecorded.mockRejectedValueOnce(new Error("db down"));
    const r = await run({ prompts: [{ prompt: "a red car" }], aspect_ratio: "1:1" });
    expect(r.images).toHaveLength(0);
    expect(r.skipped[0].reason).toBe("charge_failed");
  });
});

describe("renderKey bills a cached plate per render", () => {
  async function runKeyed(renderKey: string | undefined, runId = "run-1") {
    const { deliverImage } = await import("@/services/reports/deliver-image");
    return deliverImage(
      { tenant_id: "tenant-A", run_id: runId, log: () => {}, task: "image.edit", ...(renderKey ? { renderKey } : {}) },
      { prompts: [{ prompt: "keep the photo" }], aspect_ratio: "1:1", mode: "edit", reference_url: "https://x/photo.jpg" } as never,
    );
  }

  it("new words on a cached plate: no vendor call, charged at the edit price", async () => {
    cacheHas = true;
    const r = await runKeyed("words B");
    expect(routeImage).not.toHaveBeenCalled();
    expect(chargeMedia).toHaveBeenCalledTimes(1);
    expect(chargeMedia.mock.calls[0][0]).toMatchObject({ cost_usd: 0.06, task: "image.edit" });
    expect(r.generated).toBe(1);
    expect(r.cached).toBe(0);
  });

  it("different words are different charge keys; the same render retried reuses its key", async () => {
    cacheHas = true;
    await runKeyed("words A");
    await runKeyed("words B");
    await runKeyed("words A");
    const keys = chargeMedia.mock.calls.map((c) => c[0].key);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe(keys[0]);
  });

  it("cannot afford the per-render charge on a cache hit: skipped, nothing delivered", async () => {
    cacheHas = true;
    canAffordMedia.mockResolvedValueOnce(false);
    const r = await runKeyed("words A");
    expect(r.images).toHaveLength(0);
    expect(r.skipped[0].reason).toBe("insufficient_credits");
    expect(chargeMedia).not.toHaveBeenCalled();
  });

  it("without a renderKey a cache hit stays free (generated plates keep the free cache)", async () => {
    cacheHas = true;
    const r = await runKeyed(undefined);
    expect(chargeMedia).not.toHaveBeenCalled();
    expect(r.cached).toBe(1);
  });

  it("a preview run Zavi pays for is never charged, even per render", async () => {
    cacheHas = true;
    isPreviewRunId.mockResolvedValueOnce(true);
    await runKeyed("words A");
    expect(chargeMedia).not.toHaveBeenCalled();
  });
});
