import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const getBoolSetting = vi.fn();
vi.mock("@/services/settings", () => ({ getBoolSetting: (...a: unknown[]) => getBoolSetting(...a) }));
const vendorSubmit = vi.fn();
const vendorPollOnce = vi.fn();
const keys = new Set<string>();
vi.mock("../vendors", () => ({
  vendorCancel: vi.fn(),
  vendorSubmit: (...a: unknown[]) => vendorSubmit(...a),
  vendorPollOnce: (...a: unknown[]) => vendorPollOnce(...a),
  vendorKeyPresent: async (v: string) => keys.has(v),
}));
const generatePlatformImage = vi.fn();
vi.mock("@/services/launch-video/platform-higgsfield", () => ({
  generatePlatformImage: (...a: unknown[]) => generatePlatformImage(...a),
  isPlatformHiggsfieldConfigured: async () => false,
}));
vi.mock("@/services/logging/alert", () => ({ alert: vi.fn(async () => undefined) }));

import { downloadMedia, generateMedia, generateMediaWithFallback, isTaskConfiguredWithFallback, routeImage } from "../router";
import { DEV_STUB_MODEL } from "../dev-stub";
import { liveBuildLogoDeps, prepareGeneratedLogo } from "@/services/sites/site-logo-generate";

const ENV_KEYS = ["MEDIA_DEV_STUB", "MEDIA_DEV_STUB_EXCEPT", "MEDIA_DEV_IMAGES_DIR", "NODE_ENV", "SUPABASE_URL", "FAL_KEY"] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  keys.clear();
  keys.add("fal");
  getBoolSetting.mockResolvedValue(true);
  process.env.FAL_KEY = "k";
  process.env.NODE_ENV = "development";
  process.env.SUPABASE_URL = "https://dgzgwclslzzzrjopbobp.supabase.co";
  process.env.MEDIA_DEV_STUB = "1";
  dir = mkdtempSync(join(tmpdir(), "dev-images-"));
  process.env.MEDIA_DEV_IMAGES_DIR = dir;
  vendorSubmit.mockResolvedValue({ ok: false, reason: "out_of_credits", error: "fal submit 403: Exhausted balance", http_status: 403 });
});

afterEach(() => {
  for (const k of ENV_KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
  rmSync(dir, { recursive: true, force: true });
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

describe("media dev stub", () => {
  it("serves a photo from the local folder at zero cost while the vendor account is empty, and never calls the vendor", async () => {
    writeFileSync(join(dir, "cake.jpg"), JPEG);
    writeFileSync(join(dir, "notes.txt"), "not an image");
    const r = await generateMediaWithFallback("image.photo", { prompt: "a layered cake", aspect_ratio: "4:5" }, { pollDelayMs: 0 });
    expect(r).toMatchObject({ ok: true, model: DEV_STUB_MODEL, cost_usd: 0, mime: "image/jpeg" });
    expect(vendorSubmit).not.toHaveBeenCalled();
    expect(await downloadMedia((r as { url: string }).url, 1_000)).toEqual(JPEG);
  });

  it("the same slot always gets the same local photo, and different slots spread across the folder", async () => {
    for (const n of ["a", "b", "c", "d"]) writeFileSync(join(dir, `${n}.png`), new Uint8Array([0x89, 0x50, n.charCodeAt(0)]));
    const pick = async (prompt: string) => (await generateMedia("image.photo", { prompt, aspect_ratio: "1:1" }, { pollDelayMs: 0 })) as { url: string };
    expect((await pick("hero cake")).url).toBe((await pick("hero cake")).url);
    const urls = new Set(await Promise.all(Array.from({ length: 12 }, (_, i) => pick(`slot ${i}`).then((r) => r.url))));
    expect(urls.size).toBeGreaterThan(1);
  });

  it("with an empty folder it renders a placeholder PNG at the requested aspect", async () => {
    const r = (await generateMedia("image.hero", { prompt: "storefront", aspect_ratio: "16:9" }, { pollDelayMs: 0 })) as { url: string; cost_usd: number };
    expect(r.cost_usd).toBe(0);
    const sharp = (await import("sharp")).default;
    const meta = await sharp(Buffer.from((await downloadMedia(r.url, 5_000_000))!)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 1600, 900]);
    expect(vendorSubmit).not.toHaveBeenCalled();
  });

  it("an AI logo goes through the real logo pipeline (SVG sanitise + viewBox check) without fal, even with no fal key", async () => {
    keys.clear();
    delete process.env.FAL_KEY;
    expect(await isTaskConfiguredWithFallback("image.vector")).toBe(true);
    const prepared = await prepareGeneratedLogo(
      { tenant_id: "t", site_name: "Rise", request: { description: "a cake monogram" }, zaviPays: true },
      { ...liveBuildLogoDeps(), afford: async () => "ok" },
    );
    expect(prepared).toMatchObject({ model: DEV_STUB_MODEL, cost_usd: 0, charge: { task: "image.vector", cost_usd: 0 } });
    const paid = await prepareGeneratedLogo(
      { tenant_id: "t", site_name: "Rise", request: { description: "a cake monogram" } },
      { ...liveBuildLogoDeps(), estimate: async () => 0.08, afford: async () => "ok" },
    );
    expect(paid).toMatchObject({ model: DEV_STUB_MODEL, charge: { cost_usd: 0 } });
    expect((prepared as { svg: string }).svg).toMatch(/^<svg[^>]*viewBox="0 0 64 64"/);
    expect(vendorSubmit).not.toHaveBeenCalled();
  });

  it("MEDIA_DEV_STUB_EXCEPT=image.vector sends the build logo to the real vendor while photos stay stubbed", async () => {
    process.env.MEDIA_DEV_STUB_EXCEPT = " image.edit , image.vector ";
    writeFileSync(join(dir, "cake.jpg"), JPEG);
    const photo = await generateMediaWithFallback("image.photo", { prompt: "a layered cake", aspect_ratio: "4:5" }, { pollDelayMs: 0 });
    expect(photo).toMatchObject({ ok: true, model: DEV_STUB_MODEL, cost_usd: 0 });
    expect(vendorSubmit).not.toHaveBeenCalled();
    const logo = await prepareGeneratedLogo(
      { tenant_id: "t", site_name: "Kuki Kaka", request: { description: "a biscuit shop mark" }, zaviPays: true },
      { ...liveBuildLogoDeps(), afford: async () => "ok" },
    );
    expect(vendorSubmit).toHaveBeenCalledTimes(1);
    expect(vendorSubmit.mock.calls[0]![0]).toMatchObject({ vendor: "fal", model: "fal-ai/recraft/v4.1/text-to-vector" });
    expect(logo).toEqual({ reason: "not_configured" });
    keys.clear();
    delete process.env.FAL_KEY;
    expect(await isTaskConfiguredWithFallback("image.vector")).toBe(false);
    expect(await isTaskConfiguredWithFallback("image.photo")).toBe(true);
    expect(await routeImage("image.vector", { prompt: "p", aspect_ratio: "1:1" })).toMatchObject({ ok: false, reason: "not_configured" });
  });

  it("routeImage serves the stub even when the router is off, instead of the paid legacy rail", async () => {
    delete process.env.FAL_KEY;
    const r = await routeImage("image.photo", { prompt: "p", aspect_ratio: "1:1" });
    expect(r).toMatchObject({ ok: true, model: DEV_STUB_MODEL, cost_usd: 0 });
    expect(generatePlatformImage).not.toHaveBeenCalled();
  });

  it("does not stub video or audio: those still go to the vendor", async () => {
    const r = await generateMedia("video.broll", { prompt: "p", duration_s: 5 }, { pollDelayMs: 0 });
    expect(vendorSubmit).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
  });

  it.each([
    ["the flag is unset", { MEDIA_DEV_STUB: undefined }],
    ["the flag is not exactly 1", { MEDIA_DEV_STUB: "true" }],
    ["NODE_ENV is production", { NODE_ENV: "production" }],
    ["the backend is on the prod Supabase project", { SUPABASE_URL: "https://wmycgyjsenvgtczlupoe.supabase.co" }],
    ["SUPABASE_URL is missing", { SUPABASE_URL: undefined }],
    ["SUPABASE_URL is not a Supabase or local host", { SUPABASE_URL: "https://db.example.com" }],
  ])("is off when %s: the real vendor is called", async (_label, env) => {
    for (const [k, v] of Object.entries(env)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
    writeFileSync(join(dir, "cake.jpg"), JPEG);
    const r = await generateMediaWithFallback("image.photo", { prompt: "p", aspect_ratio: "1:1" }, { pollDelayMs: 0 });
    expect(vendorSubmit).toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, reason: "out_of_credits" });
  });
});
