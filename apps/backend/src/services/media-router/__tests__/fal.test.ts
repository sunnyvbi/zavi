import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AVATAR_DELIVERY_PROMPT, buildFalInput, falSubmit, falPollOnce, falCancel, classifyFalError } from "../vendors/fal";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("fal adapter", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { process.env.FAL_KEY = "k:s"; vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.FAL_KEY; });

  it("maps image aspect to fal image_size and pins quality=high", () => {
    expect(buildFalInput("openai/gpt-image-2.5/flare/text-to-image", { prompt: "p", aspect_ratio: "16:9" }))
      .toEqual({ prompt: "p", image_size: "landscape_16_9", quality: "high", output_format: "png", num_images: 1 });
    expect(buildFalInput("openai/gpt-image-2.5/flare/text-to-image", { prompt: "p", aspect_ratio: "4:5" }).image_size).toEqual({ width: 1024, height: 1280 });
    expect(buildFalInput("fal-ai/flux-2/klein/4b", { prompt: "p", aspect_ratio: "4:5" }).image_size).toBe("portrait_4_3");
  });
  it("edit passes the reference URL as image_urls", () => {
    expect(buildFalInput("openai/gpt-image-2.5/flare/edit", { prompt: "p", reference_url: "https://x/y.png" }).image_urls).toEqual(["https://x/y.png"]);
  });
  it("omni-flash clamps aspect to 16:9 / 9:16 and duration to 4..10", () => {
    expect(buildFalInput("google/gemini-omni-flash/v1.1/text-to-video", { prompt: "p", aspect_ratio: "4:5", duration_s: 30 }))
      .toEqual({ prompt: "p", aspect_ratio: "9:16", duration: 10, resolution: "720p" });
  });
  it("kling duration is a string", () => {
    expect(buildFalInput("fal-ai/kling-video/v3/turbo/standard/text-to-video", { prompt: "p", duration_s: 6, aspect_ratio: "1:1" }))
      .toEqual({ prompt: "p", aspect_ratio: "1:1", duration: "6" });
  });
  it("the avatar models take image + audio and are always told how to deliver it", () => {
    expect(buildFalInput("fal-ai/bytedance/omnihuman/v1.5", { image_url: "https://i", audio_url: "https://a" }))
      .toEqual({ image_url: "https://i", audio_url: "https://a", resolution: "720p", prompt: AVATAR_DELIVERY_PROMPT });
    expect(buildFalInput("fal-ai/kling-video/ai-avatar/v2/pro", { image_url: "https://i", audio_url: "https://a" }))
      .toEqual({ image_url: "https://i", audio_url: "https://a", prompt: AVATAR_DELIVERY_PROMPT });
  });
  it("seedream names explicit pixels inside the cheap area tier (a preset resolved to 2K and doubled the bill)", () => {
    expect(buildFalInput("bytedance/seedream/v5/pro/text-to-image", { prompt: "p", aspect_ratio: "16:9" }))
      .toEqual({ prompt: "p", image_size: { width: 1536, height: 864 }, output_format: "png", num_images: 1 });
    expect(buildFalInput("bytedance/seedream/v5/pro/text-to-image", { prompt: "p", aspect_ratio: "1:1" }).image_size)
      .toEqual({ width: 1024, height: 1024 });
  });
  it("seedance 2.5 t2v: string duration clamped to 4..30, 720p, audio on, 4:5 → 3:4", () => {
    expect(buildFalInput("bytedance/seedance-2.5/text-to-video", { prompt: "p", aspect_ratio: "4:5", duration_s: 45 }))
      .toEqual({ prompt: "p", resolution: "720p", generate_audio: true, duration: "30", aspect_ratio: "3:4" });
  });
  it("seedance 2.5 reference: talking head gets portrait + voice; edit gets the clip with task=editing", () => {
    expect(buildFalInput("bytedance/seedance-2.5/reference-to-video", { image_url: "https://i", audio_url: "https://a", duration_s: 12 }))
      .toMatchObject({ image_urls: ["https://i"], audio_urls: ["https://a"], duration: "12" });
    expect(buildFalInput("bytedance/seedance-2.5/reference-to-video", { prompt: "make it night", video_url: "https://v" }))
      .toMatchObject({ video_urls: ["https://v"], task: "editing" });
  });
  it("seedance 2.5 i2v: the image is the first frame and the aspect follows it (fal accepts only auto)", () => {
    const input = buildFalInput("bytedance/seedance-2.5/image-to-video", { prompt: "p", image_url: "https://i", aspect_ratio: "9:16", duration_s: 8 });
    expect(input).toMatchObject({ image_url: "https://i", aspect_ratio: "auto", resolution: "720p", duration: "8" });
  });
  it("wan 3.0: i2v uses start_image_url; edit uses reference_video_urls", () => {
    expect(buildFalInput("alibaba/wan-3.0/image-to-video", { prompt: "p", image_url: "https://i" })).toMatchObject({ start_image_url: "https://i", resolution: "720p" });
    expect(buildFalInput("alibaba/wan-3.0/reference-to-video", { prompt: "p", video_url: "https://v" })).toMatchObject({ reference_video_urls: ["https://v"] });
  });
  it("every enabled table entry on fal has an input mapping", async () => {
    const { ROUTES } = await import("../table");
    for (const row of Object.values(ROUTES)) for (const e of row) if (e.vendor === "fal") expect(() => buildFalInput(e.model, { prompt: "p" }), e.model).not.toThrow();
  });
  it("elevenlabs takes text + voice, and stability only when the caller sets one", () => {
    expect(buildFalInput("fal-ai/elevenlabs/tts/eleven-v3", { text: "hi", voice: "Brian" })).toEqual({ text: "hi", voice: "Brian" });
    expect(buildFalInput("elevenlabs/tts/eleven-v4", { text: "hi", voice: "Jessica" })).toEqual({ text: "hi", voice: "Jessica" });
    expect(buildFalInput("elevenlabs/tts/eleven-v4", { text: "hi", voice: "Jessica", voice_stability: 0.3 })).toEqual({ text: "hi", voice: "Jessica", stability: 0.3 });
    expect(buildFalInput("elevenlabs/tts/eleven-v4", { text: "hi", voice_stability: 7 })).toEqual({ text: "hi", voice: "Brian", stability: 1 });
  });

  it("submit posts to the queue with key + retention + no-store headers", async () => {
    fetchMock.mockResolvedValueOnce(ok({ request_id: "r1", status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" }));
    const r = await falSubmit("fal-ai/flux-2/klein/4b", { prompt: "p" });
    expect(r).toEqual({ ok: true, job: { vendor: "fal", model: "fal-ai/flux-2/klein/4b", id: "r1", status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://queue.fal.run/fal-ai/flux-2/klein/4b");
    expect(init.headers.Authorization).toBe("Key k:s");
    expect(JSON.parse(init.headers["X-Fal-Object-Lifecycle-Preference"])).toEqual({ expiration_duration_seconds: 3600 });
    expect(init.headers["X-Fal-Store-IO"]).toBe("0");
  });
  it("submit without FAL_KEY is not_configured and makes no call", async () => {
    delete process.env.FAL_KEY;
    const r = await falSubmit("fal-ai/flux-2/klein/4b", { prompt: "p" });
    expect(r).toMatchObject({ ok: false, reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("poll: IN_PROGRESS → pending; COMPLETED → fetches response and extracts the url", async () => {
    const job = { vendor: "fal" as const, model: "fal-ai/flux-2/klein/4b", id: "r1", status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" };
    fetchMock.mockResolvedValueOnce(ok({ status: "IN_PROGRESS" }));
    expect(await falPollOnce(job)).toEqual({ state: "pending" });
    fetchMock.mockResolvedValueOnce(ok({ status: "COMPLETED" })).mockResolvedValueOnce(ok({ images: [{ url: "https://cdn/i.png", content_type: "image/png" }] }));
    expect(await falPollOnce(job)).toEqual({ state: "done", url: "https://cdn/i.png", mime: "image/png", duration_s: undefined });
  });
  it("poll extracts video url + duration", async () => {
    const job = { vendor: "fal" as const, model: "fal-ai/bytedance/omnihuman/v1.5", id: "r", status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" };
    fetchMock.mockResolvedValueOnce(ok({ status: "COMPLETED" })).mockResolvedValueOnce(ok({ video: { url: "https://cdn/v.mp4", content_type: "video/mp4" }, duration: 6.2 }));
    expect(await falPollOnce(job)).toEqual({ state: "done", url: "https://cdn/v.mp4", mime: "video/mp4", duration_s: 6.2 });
  });
  it("a voiceover asked for with timings returns words, not the vendor's per-character arrays", async () => {
    expect(buildFalInput("elevenlabs/tts/eleven-v4", { text: "hi", voice: "Chris", voice_timestamps: true })).toEqual({ text: "hi", voice: "Chris", timestamps: true });
    const job = { vendor: "fal" as const, model: "elevenlabs/tts/eleven-v4", id: "r", status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" };
    const timestamps = [
      { characters: ["O", "k", " ", "g"], character_start_times_seconds: [0, 0.1, 0.2, 0.3], character_end_times_seconds: [0.1, 0.2, 0.3, 0.4] },
      { characters: ["o", "."], character_start_times_seconds: [0.4, 0.5], character_end_times_seconds: [0.5, 0.6] },
    ];
    fetchMock.mockResolvedValueOnce(ok({ status: "COMPLETED" })).mockResolvedValueOnce(ok({ audio: { url: "https://cdn/v.mp3", content_type: "audio/mpeg" }, timestamps }));
    expect(await falPollOnce(job)).toEqual({ state: "done", url: "https://cdn/v.mp3", mime: "audio/mpeg", duration_s: undefined, words: [["Ok", 0, 0.2], ["go.", 0.3, 0.6]] });
    fetchMock.mockResolvedValueOnce(ok({ status: "COMPLETED" })).mockResolvedValueOnce(ok({ audio: { url: "https://cdn/v.mp3", content_type: "audio/mpeg" }, timestamps: "garbled" }));
    expect(await falPollOnce(job)).toEqual({ state: "done", url: "https://cdn/v.mp3", mime: "audio/mpeg", duration_s: undefined });
  });
  it("never sends the key to a non-fal status url", async () => {
    const r = await falPollOnce({ vendor: "fal", model: "m", id: "r", status_url: "https://evil.example/s", response_url: "https://evil.example/r" });
    expect(r).toMatchObject({ state: "failed", reason: "vendor_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("classifies refusals, balance and auth", () => {
    expect(classifyFalError(422, '{"detail":[{"type":"content_policy_violation"}]}')).toBe("refused");
    expect(classifyFalError(403, "User is locked. Reason: Exhausted balance")).toBe("out_of_credits");
    expect(classifyFalError(401, "Unauthorized")).toBe("not_configured");
    expect(classifyFalError(500, "boom")).toBe("vendor_error");
  });
  it("a 402 or an exhausted-wallet body with no other keyword is out_of_credits at submit and mid-job", async () => {
    expect(classifyFalError(402, "Payment Required")).toBe("out_of_credits");
    expect(classifyFalError(403, "Account exhausted")).toBe("out_of_credits");
    const model = "fal-ai/kling-video/v3/pro/text-to-video";
    fetchMock.mockResolvedValueOnce(new Response("Payment Required", { status: 402 }));
    expect(await falSubmit(model, { prompt: "p" })).toMatchObject({ ok: false, reason: "out_of_credits", http_status: 402 });
    const job = { vendor: "fal" as const, model, id: "r", status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" };
    fetchMock.mockResolvedValueOnce(new Response("Payment Required", { status: 402 }));
    expect(await falPollOnce(job)).toMatchObject({ state: "failed", reason: "out_of_credits" });
  });
  it("a status poll or result read fal answers with HTTP 402 carries http_status 402; a 200 completed-with-error carries none", async () => {
    const job = { vendor: "fal" as const, model: "m", id: "r", status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" };
    fetchMock.mockResolvedValueOnce(new Response("Payment Required", { status: 402 }));
    expect(await falPollOnce(job)).toEqual({ state: "failed", reason: "out_of_credits", error: "fal status 402: Payment Required", http_status: 402 });
    fetchMock.mockResolvedValueOnce(ok({ status: "COMPLETED" })).mockResolvedValueOnce(new Response("User is locked. Reason: Exhausted balance", { status: 403 }));
    expect(await falPollOnce(job)).toMatchObject({ state: "failed", reason: "out_of_credits", http_status: 403 });
    fetchMock.mockResolvedValueOnce(ok({ status: "COMPLETED" })).mockResolvedValueOnce(new Response("Payment Required", { status: 402 }));
    expect(await falPollOnce(job)).toMatchObject({ state: "failed", reason: "out_of_credits", http_status: 402 });
    fetchMock.mockResolvedValueOnce(ok({ status: "COMPLETED", error: "Exhausted balance", error_type: "balance" }));
    const completed = await falPollOnce(job);
    expect(completed).toMatchObject({ state: "failed" });
    expect("http_status" in completed).toBe(false);
  });
  it("COMPLETED with an error response is a terminal failure", async () => {
    const job = { vendor: "fal" as const, model: "m", id: "r", status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" };
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(ok({ status: "COMPLETED" })).mockResolvedValueOnce(new Response('{"detail":[{"type":"content_policy_violation"}]}', { status: 422 }));
    expect(await falPollOnce(job)).toMatchObject({ state: "failed", reason: "refused" });
  });
  it("an unknown terminal status is a failure, not pending forever", async () => {
    const job = { vendor: "fal" as const, model: "m", id: "r", status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" };
    fetchMock.mockResolvedValueOnce(ok({ status: "CANCELLED" }));
    expect(await falPollOnce(job)).toMatchObject({ state: "failed", reason: "vendor_error" });
    fetchMock.mockResolvedValueOnce(ok({ status: "IN_QUEUE" }));
    expect(await falPollOnce(job)).toEqual({ state: "pending" });
  });
  it("cancel PUTs the status url's /cancel twin on the queue host, with the key", async () => {
    const job = { vendor: "fal" as const, model: "bytedance/seedance-2.5/text-to-video", id: "r1", status_url: "https://queue.fal.run/bytedance/seedance-2.5/requests/r1/status", response_url: "https://queue.fal.run/bytedance/seedance-2.5/requests/r1" };
    fetchMock.mockResolvedValueOnce(new Response('{"status":"CANCELLATION_REQUESTED"}', { status: 202 }));
    expect(await falCancel(job)).toBe("requested");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://queue.fal.run/bytedance/seedance-2.5/requests/r1/cancel");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Key k:s");
    fetchMock.mockResolvedValueOnce(new Response('{"status":"ALREADY_COMPLETED"}', { status: 400 }));
    expect(await falCancel(job)).toBe("too_late");
    fetchMock.mockRejectedValueOnce(new Error("net"));
    expect(await falCancel(job)).toBe("error");
  });
  it("cancel prefers the cancel_url fal returned, and reads 404 as not_found", async () => {
    const job = { vendor: "fal" as const, model: "m", id: "r1", status_url: "https://queue.fal.run/a/requests/r1/status", response_url: "https://queue.fal.run/a/requests/r1", cancel_url: "https://queue.fal.run/a/requests/r1/cancel" };
    fetchMock.mockResolvedValueOnce(new Response('{"status":"NOT_FOUND"}', { status: 404 }));
    expect(await falCancel(job)).toBe("not_found");
    expect(fetchMock.mock.calls[0][0]).toBe(job.cancel_url);
    fetchMock.mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    expect(await falCancel(job)).toBe("error");
  });
  it("submit keeps fal's cancel_url on the JobRef", async () => {
    fetchMock.mockResolvedValueOnce(ok({ request_id: "r1", status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r", cancel_url: "https://queue.fal.run/x/cancel" }));
    const r = await falSubmit("fal-ai/flux-2/klein/4b", { prompt: "p" });
    expect(r).toMatchObject({ ok: true, job: { cancel_url: "https://queue.fal.run/x/cancel" } });
  });
  it("COMPLETED carrying an error is a terminal failure without fetching a result", async () => {
    const job = { vendor: "fal" as const, model: "m", id: "r", status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" };
    fetchMock.mockResolvedValueOnce(ok({ status: "COMPLETED", error: "Request was cancelled", error_type: "request_cancelled" }));
    expect(await falPollOnce(job)).toMatchObject({ state: "failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("a finished job whose result read hiccups (429/5xx) is still pending, not failed", async () => {
    const job = { vendor: "fal" as const, model: "m", id: "r", status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" };
    fetchMock.mockResolvedValueOnce(ok({ status: "COMPLETED" })).mockResolvedValueOnce(new Response("upstream", { status: 503 }));
    expect(await falPollOnce(job)).toEqual({ state: "pending" });
    fetchMock.mockResolvedValueOnce(ok({ status: "COMPLETED" })).mockResolvedValueOnce(new Response("slow down", { status: 429 }));
    expect(await falPollOnce(job)).toEqual({ state: "pending" });
  });
  it("cancel never sends the key off the queue host", async () => {
    expect(await falCancel({ vendor: "fal", model: "m", id: "r", status_url: "https://evil.example/requests/r/status", response_url: "https://evil.example/r" })).toBe("error");
    expect(await falCancel({ vendor: "fal", model: "m", id: "r", status_url: "https://queue.fal.run/a/requests/r/status", cancel_url: "https://evil.example/requests/r/cancel" })).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Recraft vector colours", () => {
  it("sends the brand colours to Recraft as RGB, and nothing when there are none", () => {
    const colors = [{ r: 240, g: 149, b: 107 }, { r: 42, g: 26, b: 20 }];
    expect(buildFalInput("fal-ai/recraft/v4.1/text-to-vector", { prompt: "p", aspect_ratio: "1:1", colors })).toEqual({ prompt: "p", image_size: "square_hd", colors });
    expect(buildFalInput("fal-ai/recraft/v4.1/text-to-vector", { prompt: "p", aspect_ratio: "1:1" })).toEqual({ prompt: "p", image_size: "square_hd" });
    expect(buildFalInput("fal-ai/flux-2/pro", { prompt: "p", colors })).not.toHaveProperty("colors");
  });
});
