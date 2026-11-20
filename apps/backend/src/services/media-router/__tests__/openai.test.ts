import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openaiSubmit } from "../vendors/openai";

describe("openai adapter", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { process.env.OPENAI_API_KEY = "sk"; vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.OPENAI_API_KEY; });

  it("image generation returns an inline data URL", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: "AAAA" }] }), { status: 200 }));
    const r = await openaiSubmit("gpt-image-2.5-flare", { prompt: "p", aspect_ratio: "16:9" });
    expect(r).toMatchObject({ ok: true, job: { vendor: "openai", inline: { url: "data:image/png;base64,AAAA", mime: "image/png" } } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: "gpt-image-2.5-flare", prompt: "p", size: "1536x1024", quality: "high", n: 1 });
  });
  it("TTS returns inline mp3", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const r = await openaiSubmit("gpt-4o-mini-tts", { text: "hi" });
    expect(r).toMatchObject({ ok: true, job: { inline: { mime: "audio/mpeg", url: "data:audio/mpeg;base64,AQID" } } });
  });
  it("moderation block is refused", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "moderation_blocked", message: "x" } }), { status: 400 }));
    expect(await openaiSubmit("gpt-image-2.5-flare", { prompt: "p" })).toMatchObject({ ok: false, reason: "refused" });
  });
  it("no key → not_configured, no call", async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await openaiSubmit("gpt-image-2.5-flare", { prompt: "p" })).toMatchObject({ ok: false, reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("edit refuses a non-https reference without fetching it", async () => {
    expect(await openaiSubmit("gpt-image-2.5-flare", { prompt: "p", reference_url: "http://169.254.169.254/x" })).toMatchObject({ ok: false, reason: "vendor_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
