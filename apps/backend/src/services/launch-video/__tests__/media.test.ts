import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateBeatMedia, hashOf, type MediaDeps } from "../media";
import type { VideoBrief } from "../brief-mapper";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: mocks.rpc,
    storage: { from: () => ({ download: async () => ({ data: null, error: "x" }), upload: async () => ({}) }) },
  }),
}));

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: "charged", error: null });
  delete process.env.FAL_KEY;
});

const M = { tenant_id: "tnt-1", run_id: "run-1" } as const;

const PNG = (tag: string) => new TextEncoder().encode(`png:${tag}`);

function briefWith(prompts: { hero?: string; items: (string | undefined)[] }): VideoBrief {
  const items = prompts.items.map((p, i) => ({
    title: `Item ${i}`,
    chips: ["x"],
    ...(p ? { imagePrompt: p } : {}),
  }));
  return {
    product: { name: "Test", oneLiner: "One liner", url: "https://t.co" },
    brand: { primaryColor: "#5B6CFF", accentColor: "#22D3EE" },
    audience: "a",
    tone: "bold",
    cta: { text: "Go", url: "https://t.co" },
    beats: [
      { kind: "hook", headline: "h", ...(prompts.hero ? { imagePrompt: prompts.hero } : {}) },
      { kind: "productui", items },
      { kind: "cta", headline: "c" },
    ],
  };
}

function brollBrief(prompt: string): VideoBrief {
  return {
    product: { name: "Test", oneLiner: "One liner", url: "https://t.co" },
    brand: { primaryColor: "#5B6CFF", accentColor: "#22D3EE" },
    audience: "a",
    tone: "bold",
    cta: { text: "Go", url: "https://t.co" },
    beats: [
      { kind: "hook", headline: "h" },
      { kind: "broll", videoPrompt: prompt },
      { kind: "cta", headline: "c" },
    ],
  };
}

function fakeDeps(over: Partial<MediaDeps> = {}): MediaDeps {
  return {
    generateImage: vi.fn(async (prompt: string) => ({ ok: true as const, imageUrl: `https://img/${encodeURIComponent(prompt)}.png`, credits: 1 })),
    generateVideo: vi.fn(async (prompt: string) => ({ ok: true as const, videoUrl: `https://vid/${encodeURIComponent(prompt)}.mp4`, credits: 30 })),
    cacheGet: vi.fn(async () => null),
    cachePut: vi.fn(async () => {}),
    download: vi.fn(async (url: string) => PNG(url)),
    canAfford: vi.fn(async () => true),
    ...over,
  };
}

describe("generateBeatImages — budget cap, cache, degrade", () => {
  it("generates an image for the hero + each prompted item (real images, no fabrication)", async () => {
    const deps = fakeDeps();
    const r = await generateBeatMedia(briefWith({ hero: "a row of cars", items: ["tesla", "jeep"] }), { ...M }, deps);
    expect(r.images).toHaveLength(3);
    expect(r.creditsSpent).toBe(3);
    expect(r.images.find((i) => i.beatIndex === 0 && i.itemIndex === null)).toBeTruthy();
    expect(r.images.filter((i) => i.beatIndex === 1)).toHaveLength(2);
    for (const im of r.images) expect(im.filename).toMatch(/^img_[0-9a-f]{24}\.png$/);
  });

  it("items WITHOUT a prompt are skipped (glyph fallback, no credit)", async () => {
    const deps = fakeDeps();
    const r = await generateBeatMedia(briefWith({ items: ["tesla", undefined, "camry"] }), { ...M }, deps);
    expect(r.images).toHaveLength(2);
    expect(r.creditsSpent).toBe(2);
  });

  it("ENFORCES the credit cap — stops generating + degrades the rest to glyph", async () => {
    const deps = fakeDeps();
    const r = await generateBeatMedia(briefWith({ items: ["a", "b", "c", "d", "e"] }), { ...M, budgetCredits: 2 }, deps);
    expect(r.creditsSpent).toBe(2);
    expect(r.images).toHaveLength(2);
    expect(deps.generateImage).toHaveBeenCalledTimes(2);
    expect(r.log.some((l) => l.includes("BUDGET CAP"))).toBe(true);
  });

  it("CACHE HIT reuses a stored image for 0 credits (re-render spends nothing)", async () => {
    const stored = PNG("cached");
    const deps = fakeDeps({ cacheGet: vi.fn(async () => stored) });
    const r = await generateBeatMedia(briefWith({ items: ["tesla", "jeep"] }), { ...M }, deps);
    expect(r.images).toHaveLength(2);
    expect(r.creditsSpent).toBe(0);
    expect(deps.generateImage).not.toHaveBeenCalled();
    expect(r.images[0].bytes).toEqual(stored);
  });

  it("same prompt twice in one brief → ONE generation (in-render dedup, no double charge)", async () => {
    const deps = fakeDeps();
    const r = await generateBeatMedia(briefWith({ items: ["tesla", "tesla"] }), { ...M }, deps);
    expect(r.images).toHaveLength(2);
    expect(r.creditsSpent).toBe(1);
    expect(deps.generateImage).toHaveBeenCalledTimes(1);
  });

  it("GRACEFUL DEGRADE — a generation failure drops that image, others still render", async () => {
    let n = 0;
    const deps = fakeDeps({
      generateImage: vi.fn(async (p: string) => {
        n++;
        return n === 1 ? { ok: false as const, error: "nsfw" } : { ok: true as const, imageUrl: `https://img/${encodeURIComponent(p)}.png`, credits: 1 };
      }),
    });
    const r = await generateBeatMedia(briefWith({ items: ["bad", "good"] }), { ...M }, deps);
    expect(r.images).toHaveLength(1);
    expect(r.creditsSpent).toBe(1);
    expect(r.log.some((l) => l.includes("degrade"))).toBe(true);
  });

  it("GRACEFUL DEGRADE — a download failure drops that image (no crash)", async () => {
    const deps = fakeDeps({ download: vi.fn(async () => null) });
    const r = await generateBeatMedia(briefWith({ items: ["x"] }), { ...M }, deps);
    expect(r.images).toHaveLength(0);
    expect(r.creditsSpent).toBe(1);
  });

  it("NEVER throws even if a dep throws (whole media phase degrades cleanly)", async () => {
    const deps = fakeDeps({ generateImage: vi.fn(async () => { throw new Error("boom"); }) });
    const r = await generateBeatMedia(briefWith({ items: ["x", "y"] }), { ...M }, deps);
    expect(r.images).toHaveLength(0);
    expect(r.creditsSpent).toBe(0);
  });

  it("a brief with NO prompts → zero work, zero credits (the no-credit MG/glyph path)", async () => {
    const deps = fakeDeps();
    const r = await generateBeatMedia(briefWith({ items: [undefined, undefined] }), { ...M }, deps);
    expect(r.images).toHaveLength(0);
    expect(r.creditsSpent).toBe(0);
    expect(deps.generateImage).not.toHaveBeenCalled();
  });
});

describe("generateBeatMedia — b-roll (Phase 4) under the combined budget", () => {
  it("generates a b-roll clip for a broll beat (seedance ~30cr) into videos[]", async () => {
    const deps = fakeDeps();
    const r = await generateBeatMedia(brollBrief("slow dolly past parked cars"), { ...M }, deps);
    expect(r.videos).toHaveLength(1);
    expect(r.videos[0].beatIndex).toBe(1);
    expect(r.videos[0].filename).toMatch(/^vid_[0-9a-f]{24}\.mp4$/);
    expect(r.creditsSpent).toBe(30);
  });

  it("images + b-roll share ONE budget — images go first, then b-roll if it fits", async () => {
    const brief: VideoBrief = {
      product: { name: "T", oneLiner: "o", url: "https://t.co" },
      brand: { primaryColor: "#5B6CFF", accentColor: "#22D3EE" },
      audience: "a", tone: "bold", cta: { text: "Go", url: "https://t.co" },
      beats: [
        { kind: "hook", headline: "h", imagePrompt: "hero" },
        { kind: "broll", videoPrompt: "clip" },
        { kind: "productui", items: [{ title: "I", chips: ["x"], imagePrompt: "item" }] },
        { kind: "cta", headline: "c" },
      ],
    };
    const r = await generateBeatMedia(brief, { ...M, budgetCredits: 150 }, fakeDeps());
    expect(r.images).toHaveLength(2);
    expect(r.videos).toHaveLength(1);
    expect(r.creditsSpent).toBe(32);
  });

  it("CAP applies across kinds — a b-roll that would exceed the budget is dropped", async () => {
    const brief: VideoBrief = {
      product: { name: "T", oneLiner: "o", url: "https://t.co" },
      brand: { primaryColor: "#5B6CFF", accentColor: "#22D3EE" },
      audience: "a", tone: "bold", cta: { text: "Go", url: "https://t.co" },
      beats: [
        { kind: "hook", headline: "h", imagePrompt: "hero" },
        { kind: "broll", videoPrompt: "clip" },
        { kind: "cta", headline: "c" },
      ],
    };
    const r = await generateBeatMedia(brief, { ...M, budgetCredits: 10 }, fakeDeps());
    expect(r.images).toHaveLength(1);
    expect(r.videos).toHaveLength(0);
    expect(r.creditsSpent).toBe(1);
    expect(r.log.some((l) => l.includes("BUDGET CAP"))).toBe(true);
  });

  it("GRACEFUL DEGRADE — a b-roll generation failure drops the clip (no crash, video render falls back)", async () => {
    const deps = fakeDeps({ generateVideo: vi.fn(async () => ({ ok: false as const, error: "timeout" })) });
    const r = await generateBeatMedia(brollBrief("clip"), { ...M }, deps);
    expect(r.videos).toHaveLength(0);
    expect(r.creditsSpent).toBe(0);
  });

  it("b-roll CACHE HIT reuses a stored clip for 0 credits", async () => {
    const stored = new TextEncoder().encode("mp4:cached");
    const deps = fakeDeps({ cacheGet: vi.fn(async () => stored) });
    const r = await generateBeatMedia(brollBrief("clip"), { ...M }, deps);
    expect(r.videos).toHaveLength(1);
    expect(r.creditsSpent).toBe(0);
    expect(deps.generateVideo).not.toHaveBeenCalled();
  });
});

describe("generateBeatMedia — platform Higgsfield meter", () => {
  const keysFrom = () =>
    mocks.rpc.mock.calls.map((c) => (c[1] as { p_idempotency_key: string }).p_idempotency_key);

  it("meters EVERY generation, one distinct idempotency key per ASSET (not per run)", async () => {
    const deps = fakeDeps();
    const r = await generateBeatMedia(briefWith({ hero: "hero", items: ["a", "b", "c"] }), { ...M }, deps);
    expect(r.images).toHaveLength(4);
    const keys = keysFrom();
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    expect(keys).toEqual([
      "run-1:lv-image:v0:0:hero",
      "run-1:lv-image:v0:1:0",
      "run-1:lv-image:v0:1:1",
      "run-1:lv-image:v0:1:2",
    ]);
  });

  it("RETRY DOUBLE-SPEND: the same asset charged twice → 'charged' then 'already', and the SECOND run does NOT call the vendor", async () => {
    const claimed = new Set<string>();
    mocks.rpc.mockImplementation(async (_fn: string, args: { p_idempotency_key: string }) => {
      if (claimed.has(args.p_idempotency_key)) return { data: "already", error: null };
      claimed.add(args.p_idempotency_key);
      return { data: "charged", error: null };
    });

    const brief = briefWith({ items: ["tesla"] });
    const first = fakeDeps();
    const r1 = await generateBeatMedia(brief, { ...M }, first);
    expect(r1.images).toHaveLength(1);
    expect(first.generateImage).toHaveBeenCalledTimes(1);

    const retry = fakeDeps();
    const r2 = await generateBeatMedia(brief, { ...M }, retry);
    expect(retry.generateImage).not.toHaveBeenCalled();
    expect(r2.images).toHaveLength(0);
    expect(r2.creditsSpent).toBe(0);
    expect(r2.log.some((l) => l.includes("METER already"))).toBe(true);
  });

  it("FAIL CLOSED: the meter RPC errors → the vendor is NEVER called", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    const deps = fakeDeps();
    const r = await generateBeatMedia(briefWith({ items: ["x", "y"] }), { ...M }, deps);
    expect(deps.generateImage).not.toHaveBeenCalled();
    expect(r.images).toHaveLength(0);
    expect(r.creditsSpent).toBe(0);
    expect(r.log.some((l) => l.includes("METER meter_error"))).toBe(true);
  });

  it("FAIL CLOSED: no tenant_id/run_id → unattributable spend is refused (vendor never called)", async () => {
    const deps = fakeDeps();
    const r = await generateBeatMedia(briefWith({ items: ["x"] }), {}, deps);
    expect(deps.generateImage).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(r.images).toHaveLength(0);
  });

  it("FAIL SOFT: over_cap drops that asset — the render still ships (other assets unaffected)", async () => {
    let n = 0;
    mocks.rpc.mockImplementation(async () => {
      n++;
      return { data: n === 1 ? "charged" : "over_cap", error: null };
    });
    const deps = fakeDeps();
    const r = await generateBeatMedia(briefWith({ items: ["a", "b", "c"] }), { ...M }, deps);
    expect(deps.generateImage).toHaveBeenCalledTimes(1);
    expect(r.images).toHaveLength(1);
    expect(r.log.some((l) => l.includes("METER over_cap"))).toBe(true);
  });

  it("a CACHE HIT spends no meter charge (free asset must not consume the daily cap)", async () => {
    const deps = fakeDeps({ cacheGet: vi.fn(async () => PNG("cached")) });
    const r = await generateBeatMedia(briefWith({ items: ["tesla"] }), { ...M }, deps);
    expect(r.images).toHaveLength(1);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("an asset the per-render budget already rejected does NOT claim a key (it must stay generatable on a bigger-budget re-render)", async () => {
    const deps = fakeDeps();
    const r = await generateBeatMedia(briefWith({ items: ["a", "b"] }), { ...M, budgetCredits: 1 }, deps);
    expect(r.images).toHaveLength(1);
    expect(keysFrom()).toEqual(["run-1:lv-image:v0:1:0"]);
  });

  it("multi-variant: the same beat in two variants is two DISTINCT charges", async () => {
    const deps = fakeDeps();
    await generateBeatMedia(briefWith({ items: ["a"] }), { ...M, variant: "A" }, deps);
    await generateBeatMedia(briefWith({ items: ["a"] }), { ...M, variant: "B" }, fakeDeps());
    expect(keysFrom()).toEqual(["run-1:lv-image:A:1:0", "run-1:lv-image:B:1:0"]);
  });

  it("b-roll clips are metered too, on their own surface", async () => {
    const deps = fakeDeps();
    await generateBeatMedia(brollBrief("clip"), { ...M }, deps);
    expect(keysFrom()).toEqual(["run-1:lv-video:v0:1"]);
  });
});

describe("generateBeatMedia — router cache scoping + pending charges", () => {
  it("cache hash is TENANT- and MODEL-scoped (it was shared across tenants and pinned to nano_banana)", () => {
    expect(hashOf("t1", "m", "p")).not.toBe(hashOf("t2", "m", "p"));
    expect(hashOf("t1", "m1", "p")).not.toBe(hashOf("t1", "m2", "p"));
    expect(hashOf("t1", "m", "p1")).not.toBe(hashOf("t1", "m", "p2"));
    expect(hashOf("t1", "m", "p")).toBe(hashOf("t1", "m", "p"));
    expect(hashOf("t1", "m", "p")).toMatch(/^[0-9a-f]{24}$/);
  });

  it("returns ONE pending charge per generated asset, keyed like the meter key", async () => {
    const deps = fakeDeps({
      generateImage: vi.fn(async () => ({ ok: true as const, imageUrl: "https://img/x.png", cost_usd: 0.06, model: "seedream" })),
    });
    const r = await generateBeatMedia(briefWith({ hero: "hero", items: [] }), { ...M }, deps);
    expect(r.images).toHaveLength(1);
    expect(r.pendingCharges).toEqual([
      {
        tenant_id: "tnt-1",
        run_id: "run-1",
        key: "run-1:lv-image:v0:0:hero",
        cost_usd: 0.06,
        task: "image.hero",
        model: "seedream",
      },
    ]);
  });

  it("b-roll charges on its own task + surface key", async () => {
    const deps = fakeDeps({
      generateVideo: vi.fn(async () => ({ ok: true as const, videoUrl: "https://vid/x.mp4", cost_usd: 2.838, model: "seedance" })),
    });
    const r = await generateBeatMedia(brollBrief("clip"), { ...M }, deps);
    expect(r.pendingCharges).toEqual([
      { tenant_id: "tnt-1", run_id: "run-1", key: "run-1:lv-video:v0:1", cost_usd: 2.838, task: "video.broll", model: "seedance" },
    ]);
  });

  it("a CACHE HIT is free — no pending charge (a re-render must not re-bill)", async () => {
    const deps = fakeDeps({ cacheGet: vi.fn(async () => PNG("cached")) });
    const r = await generateBeatMedia(briefWith({ items: ["tesla"] }), { ...M }, deps);
    expect(r.images).toHaveLength(1);
    expect(r.pendingCharges).toEqual([]);
  });

  it("a legacy (cost-free) generation produces no charge", async () => {
    const deps = fakeDeps();
    const r = await generateBeatMedia(briefWith({ items: ["tesla"] }), { ...M }, deps);
    expect(r.images).toHaveLength(1);
    expect(r.pendingCharges).toEqual([]);
  });

  it("CANNOT AFFORD → that asset degrades to its fallback and the vendor is never called", async () => {
    const deps = fakeDeps({ canAfford: vi.fn(async () => false) });
    const r = await generateBeatMedia(briefWith({ hero: "hero", items: ["a"] }), { ...M }, deps);
    expect(deps.generateImage).not.toHaveBeenCalled();
    expect(r.images).toHaveLength(0);
    expect(r.pendingCharges).toEqual([]);
    expect(r.log.some((l) => l.includes("insufficient credits"))).toBe(true);
  });

  it("a download failure charges NOTHING (the customer never got the asset)", async () => {
    const deps = fakeDeps({
      generateImage: vi.fn(async () => ({ ok: true as const, imageUrl: "https://img/x.png", cost_usd: 0.06, model: "seedream" })),
      download: vi.fn(async () => null),
    });
    const r = await generateBeatMedia(briefWith({ items: ["x"] }), { ...M }, deps);
    expect(r.images).toHaveLength(0);
    expect(r.pendingCharges).toEqual([]);
  });
});
