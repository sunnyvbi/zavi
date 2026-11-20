import { describe, it, expect, vi, beforeEach } from "vitest";

const getBoolSetting = vi.fn();
vi.mock("@/services/settings", () => ({ getBoolSetting: (...a: unknown[]) => getBoolSetting(...a) }));
const vendorSubmit = vi.fn();
const vendorPollOnce = vi.fn();
const vendorCancel = vi.fn();
vi.mock("../vendors", () => ({
  vendorCancel: (...a: unknown[]) => vendorCancel(...a),
  vendorSubmit: (...a: unknown[]) => vendorSubmit(...a),
  vendorPollOnce: (...a: unknown[]) => vendorPollOnce(...a),
  vendorKeyPresent: async (v: string) => v === "fal",
}));
const generatePlatformImage = vi.fn();
vi.mock("@/services/launch-video/platform-higgsfield", () => ({
  generatePlatformImage: (...a: unknown[]) => generatePlatformImage(...a),
  isPlatformHiggsfieldConfigured: async () => true,
}));

import { cancelMedia, generateMedia, routeImage, isTaskConfigured, isMediaRouterEnabled, costForJob, downloadMedia } from "../router";

describe("media router", () => {
  beforeEach(() => { vi.clearAllMocks(); getBoolSetting.mockResolvedValue(true); process.env.FAL_KEY = "k"; });

  it("generateMedia submits to the ACTIVE route only and prices the result", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: true, job: { vendor: "fal", model: "m", id: "1" } });
    vendorPollOnce.mockResolvedValueOnce({ state: "pending" }).mockResolvedValueOnce({ state: "done", url: "https://cdn/x.png", mime: "image/png" });
    const r = await generateMedia("image.photo", { prompt: "p" }, { pollDelayMs: 0 });
    expect(r).toEqual({ ok: true, url: "https://cdn/x.png", mime: "image/png", duration_s: undefined, vendor: "fal", model: "bytedance/seedream/v5/pro/text-to-image", cost_usd: 0.0675 });
    expect(vendorSubmit).toHaveBeenCalledTimes(1);
    expect(vendorSubmit.mock.calls[0][0]).toMatchObject({ vendor: "fal", model: "bytedance/seedream/v5/pro/text-to-image" });
  });
  it("NO auto fallback: a failed active route is returned, alternates never called", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: false, reason: "vendor_error", error: "down" });
    const r = await generateMedia("image.photo", { prompt: "p" }, { pollDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, reason: "vendor_error" });
    expect(vendorSubmit).toHaveBeenCalledTimes(1);
  });
  it("times out after maxPolls and asks the vendor to stop the job it will no longer wait for", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: true, job: { vendor: "fal", model: "m", id: "1" } });
    vendorPollOnce.mockResolvedValue({ state: "pending" });
    vendorCancel.mockResolvedValueOnce("requested");
    expect(await generateMedia("video.broll", { prompt: "p" }, { pollDelayMs: 0, maxPolls: 3 })).toMatchObject({ ok: false, reason: "timeout" });
    expect(vendorCancel).toHaveBeenCalledWith({ vendor: "fal", model: "m", id: "1" });
  });
  it("resume polls the job it is handed and never submits (a retried step does not pay twice)", async () => {
    const job = { vendor: "fal" as const, model: "bytedance/seedream/v5/pro/text-to-image", id: "old" };
    vendorPollOnce.mockResolvedValueOnce({ state: "done", url: "https://cdn/x.png" });
    const onSubmitted = vi.fn();
    const r = await generateMedia("image.photo", { prompt: "p" }, { pollDelayMs: 0, resume: job, onSubmitted });
    expect(r).toMatchObject({ ok: true, url: "https://cdn/x.png", cost_usd: 0.0675 });
    expect(vendorSubmit).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(vendorPollOnce).toHaveBeenCalledWith(job);
  });
  it("onSubmitted runs before the first poll; if the JobRef cannot be recorded the job is cancelled and nothing is polled", async () => {
    const job = { vendor: "fal", model: "m", id: "1" };
    vendorSubmit.mockResolvedValueOnce({ ok: true, job });
    const r = await generateMedia("image.photo", { prompt: "p" }, { pollDelayMs: 0, onSubmitted: async () => { throw new Error("db down"); } });
    expect(r).toMatchObject({ ok: false, reason: "vendor_error" });
    expect(vendorCancel).toHaveBeenCalledWith(job);
    expect(vendorPollOnce).not.toHaveBeenCalled();
  });
  it("a timed-out job fal says already completed is read once more and used, not bought again", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: true, job: { vendor: "fal", model: "m", id: "1" } });
    vendorPollOnce.mockResolvedValueOnce({ state: "pending" }).mockResolvedValueOnce({ state: "pending" }).mockResolvedValueOnce({ state: "done", url: "https://cdn/x.png" });
    vendorCancel.mockResolvedValueOnce("too_late");
    expect(await generateMedia("image.photo", { prompt: "p" }, { pollDelayMs: 0, maxPolls: 2 })).toMatchObject({ ok: true, url: "https://cdn/x.png" });
  });
  it("cancelMedia never throws", async () => {
    vendorCancel.mockRejectedValueOnce(new Error("boom"));
    expect(await cancelMedia({ vendor: "fal", model: "m", id: "1" })).toBe("error");
  });
  it("routeImage with the switch OFF calls legacy Higgsfield and costs 0", async () => {
    getBoolSetting.mockResolvedValue(false);
    generatePlatformImage.mockResolvedValueOnce({ ok: true, imageUrl: "https://hf/i.png" });
    const r = await routeImage("image.hero", { prompt: "p", aspect_ratio: "16:9" });
    expect(r).toMatchObject({ ok: true, imageUrl: "https://hf/i.png", cost_usd: 0, model: "higgsfield-legacy" });
    expect(vendorSubmit).not.toHaveBeenCalled();
  });
  it("routeImage with the switch ON returns the legacy-compatible shape", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: true, job: { vendor: "fal", model: "m", id: "1", inline: { url: "data:image/png;base64,AA", mime: "image/png" } } });
    vendorPollOnce.mockResolvedValueOnce({ state: "done", url: "data:image/png;base64,AA", mime: "image/png" });
    expect(await routeImage("image.photo", { prompt: "p" })).toMatchObject({ ok: true, imageUrl: "data:image/png;base64,AA", cost_usd: 0.0675 });
  });
  it("isTaskConfigured checks the active vendor key when ON", async () => {
    expect(await isTaskConfigured("image.photo")).toBe(true);
  });
  it("setting ON but no FAL_KEY = router OFF (deploying before the key exists must not break images)", async () => {
    delete process.env.FAL_KEY;
    generatePlatformImage.mockResolvedValueOnce({ ok: true, imageUrl: "https://hf/i.png" });
    expect(await isMediaRouterEnabled()).toBe(false);
    expect(await routeImage("image.photo", { prompt: "p" })).toMatchObject({ ok: true, cost_usd: 0, model: "higgsfield-legacy" });
  });
  it("costForJob prices the model that actually ran, not the current table", () => {
    expect(costForJob({ vendor: "fal", model: "fal-ai/bytedance/omnihuman/v1.5", id: "x" }, {}, { duration_s: 10 })).toBeCloseTo(1.6, 5);
  });

  it("with the switch OFF, edit and vector are not_configured (legacy rail cannot do them)", async () => {
    getBoolSetting.mockResolvedValue(false);
    for (const task of ["image.edit", "image.vector"] as const) {
      expect(await isTaskConfigured(task), task).toBe(false);
      const r = await routeImage(task, { prompt: "p", reference_url: "https://x/y.png" });
      expect(r, task).toMatchObject({ ok: false, reason: "not_configured" });
    }
    expect(generatePlatformImage).not.toHaveBeenCalled();
  });

  it("with the switch OFF, photo/hero/plate/draft still fall through to Higgsfield", async () => {
    getBoolSetting.mockResolvedValue(false);
    generatePlatformImage.mockResolvedValue({ ok: true, imageUrl: "https://hf/i.png" });
    for (const task of ["image.photo", "image.hero", "image.plate", "image.draft"] as const) {
      expect(await routeImage(task, { prompt: "p" }), task).toMatchObject({ ok: true, cost_usd: 0 });
    }
  });

  it("downloadMedia refuses a non-https, non-data url before fetching", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await downloadMedia("file:///etc/passwd", 1024)).toBeNull();
    expect(await downloadMedia("http://insecure/x.png", 1024)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
