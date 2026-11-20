import { describe, it, expect, vi, beforeEach } from "vitest";

const getBoolSetting = vi.fn();
vi.mock("@/services/settings", () => ({ getBoolSetting: (...a: unknown[]) => getBoolSetting(...a) }));
const vendorSubmit = vi.fn();
const vendorPollOnce = vi.fn();
const vendorCancel = vi.fn();
const keys = new Set<string>(["fal", "openai", "gemini"]);
vi.mock("../vendors", () => ({
  vendorCancel: (...a: unknown[]) => vendorCancel(...a),
  vendorSubmit: (...a: unknown[]) => vendorSubmit(...a),
  vendorPollOnce: (...a: unknown[]) => vendorPollOnce(...a),
  vendorKeyPresent: async (v: string) => keys.has(v),
}));
vi.mock("@/services/launch-video/platform-higgsfield", () => ({
  generatePlatformImage: vi.fn(),
  isPlatformHiggsfieldConfigured: async () => true,
}));
const alert = vi.fn(async (_input: unknown) => undefined);
vi.mock("@/services/logging/alert", () => ({ alert: (input: unknown) => alert(input) }));

import { fallbackChain, generateMedia, generateMediaWithFallback, isTaskConfiguredWithFallback } from "../router";
import { __resetVendorAlertsForTests, isVendorExhausted } from "../vendor-alert";

const inline = (vendor: string, model: string) => ({ ok: true, job: { vendor, model, id: "i", inline: { url: "data:image/png;base64,AAAA", mime: "image/png" } } });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("generateMediaWithFallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetVendorAlertsForTests();
    keys.clear();
    for (const k of ["fal", "openai", "gemini"]) keys.add(k);
    getBoolSetting.mockResolvedValue(true);
    process.env.FAL_KEY = "k";
    vendorPollOnce.mockImplementation(async (job: { inline?: { url: string; mime: string } }) =>
      job.inline ? { state: "done", url: job.inline.url, mime: job.inline.mime } : { state: "pending" },
    );
  });

  it("fal out of credits: the photo is made by the next vendor in the row, priced at THAT vendor", async () => {
    vendorSubmit
      .mockResolvedValueOnce({ ok: false, reason: "out_of_credits", error: "fal submit 403: User is locked. Exhausted balance", http_status: 403 })
      .mockImplementationOnce(async (entry: { vendor: string; model: string }) => inline(entry.vendor, entry.model));
    const r = await generateMediaWithFallback("image.hero", { prompt: "p", aspect_ratio: "16:9" }, { pollDelayMs: 0 });
    expect(r).toMatchObject({ ok: true, vendor: "openai", model: "gpt-image-2.5-flare", cost_usd: 0.06 });
    expect(r.attempts).toEqual([{ vendor: "fal", model: "bytedance/seedream/v5/pro/text-to-image", reason: "out_of_credits" }]);
    expect(vendorSubmit.mock.calls.map((c) => c[0].vendor)).toEqual(["fal", "openai"]);
  });

  it("pages ops once per vendor per day and moves the empty vendor to the back for the next call", async () => {
    vendorSubmit.mockImplementation(async (entry: { vendor: string; model: string }) =>
      entry.vendor === "fal" ? { ok: false, reason: "out_of_credits", error: "balance", http_status: 403 } : inline(entry.vendor, entry.model),
    );
    await generateMediaWithFallback("image.photo", { prompt: "p" }, { pollDelayMs: 0 });
    await flush();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toMatchObject({
      source: "media-router",
      code: "media_vendor_out_of_credits",
      email: { dedupeKey: expect.stringMatching(/^media_vendor_out_of_credits:fal:\d{4}-\d{2}-\d{2}$/) },
    });
    expect(isVendorExhausted("fal")).toBe(true);
    expect((await fallbackChain("image.photo")).map((e) => e.vendor)).toEqual(["openai", "gemini", "fal"]);

    vendorSubmit.mockClear();
    const second = await generateMediaWithFallback("image.photo", { prompt: "p" }, { pollDelayMs: 0 });
    expect(second).toMatchObject({ ok: true, vendor: "openai" });
    expect(vendorSubmit.mock.calls.map((c) => c[0].vendor)).toEqual(["openai"]);
    await flush();
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("a refusal stops the chain: another vendor accepting a refused prompt is not a fix", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: false, reason: "refused", error: "content_policy" });
    const r = await generateMediaWithFallback("image.photo", { prompt: "p" }, { pollDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, reason: "refused" });
    expect(vendorSubmit).toHaveBeenCalledTimes(1);
  });

  it("a timeout stops the chain: that job may still finish and bill, so no second vendor is paid", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: true, job: { vendor: "fal", model: "m", id: "1", status_url: "s", response_url: "r" } });
    vendorCancel.mockResolvedValueOnce("requested");
    const r = await generateMediaWithFallback("image.photo", { prompt: "p" }, { pollDelayMs: 0, maxPolls: 2 });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(vendorSubmit).toHaveBeenCalledTimes(1);
  });

  it("every vendor refused at submit (4xx, nothing accepted): one try each, reports out_of_credits", async () => {
    vendorSubmit
      .mockResolvedValueOnce({ ok: false, reason: "out_of_credits", error: "balance", http_status: 403 })
      .mockResolvedValueOnce({ ok: false, reason: "vendor_error", error: "openai 400", http_status: 400 })
      .mockResolvedValueOnce({ ok: false, reason: "not_configured", error: "gemini 403", http_status: 403 });
    const r = await generateMediaWithFallback("image.hero", { prompt: "p" }, { pollDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, reason: "out_of_credits" });
    expect(r.attempts.map((a) => `${a.vendor}:${a.reason}`)).toEqual(["fal:out_of_credits", "openai:vendor_error", "gemini:not_configured"]);
    expect(vendorSubmit).toHaveBeenCalledTimes(3);
  });

  it("a vendor_error that may have billed (no HTTP answer: network timeout, lost response) stops the chain", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: false, reason: "vendor_error", error: "fal submit: The operation was aborted" });
    const r = await generateMediaWithFallback("image.photo", { prompt: "p" }, { pollDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, reason: "vendor_error" });
    expect(vendorSubmit).toHaveBeenCalledTimes(1);
  });

  it("a 5xx on submit is ambiguous (the job may be queued and bill): the chain stops", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: false, reason: "vendor_error", error: "fal submit 502", http_status: 502 });
    const r = await generateMediaWithFallback("image.photo", { prompt: "p" }, { pollDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, reason: "vendor_error" });
    expect(vendorSubmit).toHaveBeenCalledTimes(1);
  });

  it("out_of_credits reported while polling an ACCEPTED job stops the chain (it may still bill)", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: true, job: { vendor: "fal", model: "m", id: "1", status_url: "s", response_url: "r" } });
    vendorPollOnce.mockResolvedValueOnce({ state: "failed", reason: "out_of_credits", error: "fal completed with error: balance" });
    const r = await generateMediaWithFallback("image.photo", { prompt: "p" }, { pollDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, reason: "out_of_credits" });
    expect(vendorSubmit).toHaveBeenCalledTimes(1);
  });

  it("a vendor_error after the job was accepted (failed at poll) stops the chain", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: true, job: { vendor: "fal", model: "m", id: "1", status_url: "s", response_url: "r" } });
    vendorPollOnce.mockResolvedValueOnce({ state: "failed", reason: "vendor_error", error: "fal result: no output url" });
    const r = await generateMediaWithFallback("image.photo", { prompt: "p" }, { pollDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, reason: "vendor_error" });
    expect(vendorSubmit).toHaveBeenCalledTimes(1);
  });

  it("only vendors Zavi holds a key for are tried, and none means not_configured with no call", async () => {
    keys.delete("openai");
    expect((await fallbackChain("image.photo")).map((e) => e.vendor)).toEqual(["fal", "gemini"]);
    keys.clear();
    expect(await isTaskConfiguredWithFallback("image.photo")).toBe(false);
    const r = await generateMediaWithFallback("image.photo", { prompt: "p" });
    expect(r).toMatchObject({ ok: false, reason: "not_configured" });
    expect(vendorSubmit).not.toHaveBeenCalled();
  });

  it("never calls the disabled Higgsfield row", async () => {
    const chain = await fallbackChain("image.hero");
    expect(chain.some((e) => e.vendor === "higgsfield")).toBe(false);
    expect(chain.length).toBeLessThanOrEqual(3);
  });

  it("a poll fal answered with HTTP 402 keeps http_status 402 on the generateMedia failure", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: true, job: { vendor: "fal", model: "m", id: "1", status_url: "s", response_url: "r" } });
    vendorPollOnce.mockResolvedValueOnce({ state: "pending" }).mockResolvedValueOnce({ state: "failed", reason: "out_of_credits", error: "fal status 402: Payment Required", http_status: 402 });
    const r = await generateMedia("audio.voiceover", { text: "hi" }, { pollDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, reason: "out_of_credits", http_status: 402 });
    expect(vendorPollOnce).toHaveBeenCalledTimes(2);
  });

  it("a submit fal refused with HTTP 402 keeps http_status 402, and a poll failure with no HTTP answer carries none", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: false, reason: "out_of_credits", error: "fal submit 402: Payment Required", http_status: 402 });
    expect(await generateMedia("image.photo", { prompt: "p" }, { pollDelayMs: 0 })).toMatchObject({ ok: false, reason: "out_of_credits", http_status: 402, unbilled_at_submit: true });
    vendorSubmit.mockResolvedValueOnce({ ok: true, job: { vendor: "fal", model: "m", id: "1", status_url: "s", response_url: "r" } });
    vendorPollOnce.mockResolvedValueOnce({ state: "failed", reason: "out_of_credits", error: "fal completed with error: balance" });
    const r = await generateMedia("image.photo", { prompt: "p" }, { pollDelayMs: 0 });
    expect(r.ok).toBe(false);
    expect("http_status" in r).toBe(false);
  });

  it("when every vendor fails the result carries the LAST attempt's http_status, not the first", async () => {
    vendorSubmit
      .mockResolvedValueOnce({ ok: false, reason: "out_of_credits", error: "fal submit 403: Exhausted balance", http_status: 403 })
      .mockResolvedValueOnce({ ok: false, reason: "out_of_credits", error: "openai 402", http_status: 402 })
      .mockResolvedValueOnce({ ok: false, reason: "vendor_error", error: "gemini 400", http_status: 400 });
    const r = await generateMediaWithFallback("image.photo", { prompt: "p" }, { pollDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, reason: "out_of_credits", http_status: 400 });
    expect(vendorSubmit).toHaveBeenCalledTimes(3);
  });

  it("plain generateMedia still never falls back, but does page on out_of_credits", async () => {
    vendorSubmit.mockResolvedValueOnce({ ok: false, reason: "out_of_credits", error: "balance" });
    const r = await generateMedia("video.broll", { prompt: "p" }, { pollDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, reason: "out_of_credits" });
    expect(vendorSubmit).toHaveBeenCalledTimes(1);
    await flush();
    expect(alert).toHaveBeenCalledTimes(1);
  });
});
