import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const captured = vi.hoisted(() => ({ webp: [] as Uint8Array[] }));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/site-images/generate", async (orig) => {
  const real = await orig<typeof import("@/services/site-images/generate")>();
  return {
    ...real,
    toWebpVariants: vi.fn(async (bytes: Uint8Array, aspect: Parameters<typeof real.toWebpVariants>[1]) => {
      captured.webp.push(bytes);
      return real.toWebpVariants(bytes, aspect);
    }),
  };
});

import { SITE_REPO_DIR, type SiteSandbox } from "../contract";
import {
  IMAGE_MASK_MAX_BYTES,
  cleanImageRequest,
  compositeMasked,
  imagePlan,
  maskAlpha,
  photoPreview,
  prepareImage,
  type ImageReplaceDeps,
  type PreparedImage,
} from "../site-image-replace";

const TENANT = "11111111-1111-4111-8111-111111111111";
const STORED_W = 60;
const STORED_H = 40;
const W = STORED_H;
const H = STORED_W;
const CUT = 20;

function noise(width: number, height: number, seed: number): Buffer {
  const out = Buffer.alloc(width * height * 3);
  let x = seed;
  for (let i = 0; i < out.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

async function rotatedJpeg(): Promise<Buffer> {
  return sharp(noise(STORED_W, STORED_H, 7), { raw: { width: STORED_W, height: STORED_H, channels: 3 } })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

async function maskPng(width: number, height: number, paint: (x: number, y: number) => boolean): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!paint(x, y)) continue;
      raw.fill(255, (y * width + x) * 4, (y * width + x) * 4 + 4);
    }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function dataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function redPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
}

async function rgba(bytes: Uint8Array): Promise<{ data: Buffer; width: number; height: number }> {
  const r = await sharp(bytes).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: r.data, width: r.info.width, height: r.info.height };
}

function sandboxWith(files: Record<string, Buffer>): SiteSandbox {
  return {
    run: vi.fn(async (cmd: string) => {
      if (cmd.startsWith("test -e ")) return { exitCode: 0, stdout: files[cmd.split(" ")[2]!] ? "yes\n" : "no\n", stderr: "" };
      return { exitCode: 0, stdout: `__ZAVI_IMG_REFS__["src/App.tsx"]\n`, stderr: "" };
    }),
    readFile: vi.fn(async (p: string) => {
      const f = files[p.replace(`${SITE_REPO_DIR}/`, "")];
      if (!f) throw new Error("missing");
      return f;
    }),
    listFiles: vi.fn(async () => []),
  } as unknown as SiteSandbox;
}

function imageDeps(edited: Buffer, over: Partial<ImageReplaceDeps> = {}) {
  const done = vi.fn(async () => undefined);
  const deps = {
    configured: vi.fn(async () => true),
    estimate: vi.fn(async () => 0.05),
    afford: vi.fn(async () => "ok" as const),
    generate: vi.fn(async () => ({ ok: true as const, url: "https://vendor.example/out.png", cost_usd: 0.04, model: "edit-model" })),
    download: vi.fn(async () => new Uint8Array(edited)),
    fetchPublic: vi.fn(async () => null),
    shareReference: vi.fn(async () => ({ url: "https://signed.example/ref.png", done })),
    ...over,
  };
  return { deps, done };
}

function paidCalls(deps: ReturnType<typeof imageDeps>["deps"]): number {
  const calls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls.length;
  return (
    calls(deps.configured) +
    calls(deps.estimate) +
    calls(deps.afford) +
    calls(deps.shareReference) +
    calls(deps.generate)
  );
}

beforeEach(() => {
  captured.webp = [];
});

describe("cleanImageRequest with a mask", () => {
  it("accepts a PNG mask on an edit and refuses every other shape", async () => {
    const png = await maskPng(4, 4, () => true);
    const ok = cleanImageRequest({ src: "/images/a.webp", mode: "edit", text: "make the sky blue", mask: dataUrl(png) });
    expect(ok?.mask && Buffer.from(ok.mask).equals(png)).toBe(true);
    const base = { src: "/images/a.webp", mode: "edit", text: "make the sky blue" };
    expect(cleanImageRequest({ ...base, mask: dataUrl(png).replace("image/png", "image/jpeg") })).toBeNull();
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    expect(cleanImageRequest({ ...base, mask: dataUrl(jpeg) })).toBeNull();
    expect(cleanImageRequest({ ...base, mask: dataUrl(Buffer.concat([png.subarray(0, 8), Buffer.alloc(IMAGE_MASK_MAX_BYTES)])) })).toBeNull();
    expect(cleanImageRequest({ ...base, mask: 42 })).toBeNull();
    expect(cleanImageRequest({ ...base, mask: "data:image/png;base64,!!!" })).toBeNull();
    expect(cleanImageRequest({ ...base, mode: "generate", mask: dataUrl(png) })).toBeNull();
    expect(cleanImageRequest(base)).toEqual(base);
  });
});

describe("compositeMasked", () => {
  it("keeps every pixel outside the mask byte for byte and takes the edit inside", async () => {
    const reference = await sharp(noise(W, H, 3), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
    const made = await maskAlpha(await maskPng(W, H, (x) => x < CUT), W, H);
    if ("reason" in made) throw new Error(made.reason);
    const out = await rgba(await compositeMasked(reference, await redPng(W * 3, H * 2), made.alpha));
    const ref = await rgba(reference);
    let outsideDiff = 0;
    for (let y = 0; y < H; y++)
      for (let x = CUT; x < W; x++) {
        const i = (y * W + x) * 4;
        if (!out.data.subarray(i, i + 4).equals(ref.data.subarray(i, i + 4))) outsideDiff++;
      }
    expect(outsideDiff).toBe(0);
    const mid = (30 * W + 10) * 4;
    expect([...out.data.subarray(mid, mid + 4)]).toEqual([255, 0, 0, 255]);
  });
});

describe("prepareImage with a mask", () => {
  it("edits only the brushed region of a rotated photo, then converts as before", async () => {
    const old = await rotatedJpeg();
    const sandbox = sandboxWith({ "public/images/hero.jpg": old });
    const { deps, done } = imageDeps(await redPng(512, 768));
    const request = cleanImageRequest({
      src: "/images/hero.jpg",
      mode: "edit",
      text: "make it red",
      mask: dataUrl(await maskPng(W, H, (x) => x < CUT)),
    })!;
    const prepared = await prepareImage(sandbox, { tenant_id: TENANT, site_id: "s1", request }, deps);
    if ("reason" in prepared) throw new Error(prepared.reason);
    expect(deps.generate).toHaveBeenCalledTimes(1);
    expect((deps.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("image.edit");
    expect(done).toHaveBeenCalledTimes(1);
    expect(prepared.charge).toEqual({ task: "image.edit", cost_usd: 0.04 });
    expect(prepared.variants.length).toBeGreaterThan(0);

    expect(captured.webp).toHaveLength(1);
    const out = await rgba(captured.webp[0]!);
    const ref = await rgba(old);
    expect([out.width, out.height]).toEqual([W, H]);
    expect([ref.width, ref.height]).toEqual([W, H]);
    let outsideDiff = 0;
    let insideRed = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const px = out.data.subarray(i, i + 4);
        if (x >= CUT && !px.equals(ref.data.subarray(i, i + 4))) outsideDiff++;
        if (x < CUT && px[0] === 255 && px[1] === 0 && px[2] === 0) insideRed++;
      }
    expect(outsideDiff).toBe(0);
    expect(insideRed).toBeGreaterThan(CUT * H * 0.5);

    const shared = (deps.shareReference as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Uint8Array;
    expect((await rgba(shared)).data.equals(ref.data)).toBe(true);

    const outcome = { value: null };
    const plan = await imagePlan(prepared as PreparedImage, outcome)(
      sandboxWith({ "public/images/hero.jpg": old, "src/App.tsx": Buffer.from('<img src="/images/hero.jpg" />') }),
    );
    expect("label" in plan && plan.label).toBe("Edited part of a photo with AI");
  });

  it("refuses an empty, misaligned or broken mask before the wallet or the vendor", async () => {
    const old = await rotatedJpeg();
    const cases: Array<[string, Buffer]> = [
      ["mask_empty", await maskPng(W, H, () => false)],
      ["mask_unreadable", await maskPng(H, W, (x) => x < CUT)],
      ["mask_unreadable", Buffer.concat([(await maskPng(W, H, () => true)).subarray(0, 8), Buffer.from("not really a png at all")])],
    ];
    for (const [reason, mask] of cases) {
      const { deps } = imageDeps(await redPng(W, H));
      const request = cleanImageRequest({ src: "/images/hero.jpg", mode: "edit", text: "make it red", mask: dataUrl(mask) })!;
      expect(request).not.toBeNull();
      const r = await prepareImage(sandboxWith({ "public/images/hero.jpg": old }), { tenant_id: TENANT, site_id: "s1", request }, deps);
      expect(r).toEqual({ reason });
      expect(paidCalls(deps)).toBe(0);
    }
    expect(captured.webp).toHaveLength(0);
  });

  it("charges nothing and composites nothing when the vendor fails", async () => {
    const old = await rotatedJpeg();
    const { deps, done } = imageDeps(await redPng(W, H), {
      generate: vi.fn(async () => ({ ok: false as const, reason: "vendor_error" as const, error: "boom" })),
    });
    const request = cleanImageRequest({ src: "/images/hero.jpg", mode: "edit", text: "make it red", mask: dataUrl(await maskPng(W, H, (x) => x < CUT)) })!;
    const r = await prepareImage(sandboxWith({ "public/images/hero.jpg": old }), { tenant_id: TENANT, site_id: "s1", request }, deps);
    expect(r).toEqual({ reason: "generation_failed" });
    expect(deps.download).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
    expect(captured.webp).toHaveLength(0);
  });

  it("leaves a whole-photo edit as it was: the vendor's photo goes straight to conversion", async () => {
    const old = await rotatedJpeg();
    const edited = await redPng(W, H);
    const { deps } = imageDeps(edited);
    const request = cleanImageRequest({ src: "/images/hero.jpg", mode: "edit", text: "make it red" })!;
    const r = await prepareImage(sandboxWith({ "public/images/hero.jpg": old }), { tenant_id: TENANT, site_id: "s1", request }, deps);
    expect("reason" in r).toBe(false);
    expect(Buffer.from(captured.webp[0]!).equals(edited)).toBe(true);
  });
});

describe("photoPreview", () => {
  it("returns the photo the way it is shown, at its turned natural size", async () => {
    const p = await photoPreview(sandboxWith({ "public/images/hero.jpg": await rotatedJpeg() }), "/images/hero.jpg");
    expect(p).toMatchObject({ width: W, height: H });
    expect(p!.data_url.startsWith("data:image/webp;base64,")).toBe(true);
    expect(await photoPreview(sandboxWith({}), "/images/hero.jpg")).toBeNull();
    expect(await photoPreview(sandboxWith({}), "https://evil.example/x.png")).toBeNull();
  });
});

it.each(["image-model", "dev-stub"])("uses the vendor estimate for real zero-cost results but not local stubs: %s", async (model) => {
  const old = await rotatedJpeg();
  const { deps } = imageDeps(await redPng(512, 768), { generate: vi.fn(async () => ({ ok: true as const, url: "https://vendor.example/out.png", cost_usd: 0, model })) });
  const request = cleanImageRequest({ src: "/images/hero.jpg", mode: "generate", text: "Warm sunlight in the bakery" })!;
  const prepared = await prepareImage(sandboxWith({ "public/images/hero.jpg": old }), { tenant_id: TENANT, site_id: "s1", request }, deps);
  if ("reason" in prepared) throw new Error(prepared.reason);
  expect(prepared.charge).toEqual(model === "dev-stub" ? null : { task: "image.photo", cost_usd: 0.05 });
});
