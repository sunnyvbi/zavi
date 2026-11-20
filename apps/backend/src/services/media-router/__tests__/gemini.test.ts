import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { geminiSubmit, pcmToWav } from "../vendors/gemini";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });

describe("gemini adapter", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { process.env.GEMINI_API_KEY = "g"; vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.GEMINI_API_KEY; });

  it("image returns inline data URL", async () => {
    fetchMock.mockResolvedValueOnce(json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "QQ==" } }] } }] }));
    const r = await geminiSubmit("gemini-3.1-flash-image-preview", { prompt: "p", aspect_ratio: "9:16" });
    expect(r).toMatchObject({ ok: true, job: { inline: { url: "data:image/png;base64,QQ==", mime: "image/png" } } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig).toEqual({ responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "9:16" } });
  });
  it("sends the key as a header, never in the URL", async () => {
    fetchMock.mockResolvedValueOnce(json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "QQ==" } }] } }] }));
    await geminiSubmit("gemini-3-pro-image-preview", { prompt: "p" });
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("key=");
    expect(fetchMock.mock.calls[0][1].headers["x-goog-api-key"]).toBe("g");
  });
  it("safety block is refused", async () => {
    fetchMock.mockResolvedValueOnce(json({ promptFeedback: { blockReason: "SAFETY" } }));
    expect(await geminiSubmit("gemini-3.1-flash-image-preview", { prompt: "p" })).toMatchObject({ ok: false, reason: "refused" });
  });
  it("wraps PCM in a 44-byte WAV header", () => {
    const wav = pcmToWav(Buffer.from([0, 0, 1, 0]));
    expect(wav.length).toBe(48);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
  });
});
