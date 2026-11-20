import type { MediaFailReason, MediaRequest, SubmitResult } from "../types";
import { safeFetchImage } from "./safe-fetch";

const API = "https://generativelanguage.googleapis.com/v1beta";

function classify(status: number, body: string): MediaFailReason {
  const b = body.toLowerCase();
  if (b.includes("safety") || b.includes("blocked") || b.includes("prohibited")) return "refused";
  if (b.includes("quota") || b.includes("billing")) return "out_of_credits";
  if (status === 401 || status === 403) return "not_configured";
  return "vendor_error";
}

export function pcmToWav(pcm: Buffer, sampleRate = 24_000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export async function geminiSubmit(model: string, req: MediaRequest): Promise<SubmitResult> {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) return { ok: false, reason: "not_configured", error: "GEMINI_API_KEY not set" };
  try {
    const isTts = model.includes("tts");
    const parts: Array<Record<string, unknown>> = [{ text: isTts ? req.text : req.prompt }];
    if (!isTts && req.reference_url) {
      const img = await safeFetchImage(req.reference_url);
      if (!img) return { ok: false, reason: "vendor_error", error: "reference_url must be a public https image ≤10MB" };
      parts.push({ inlineData: { mimeType: img.mime, data: img.bytes.toString("base64") } });
    }
    const res = await fetch(`${API}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(
        isTts
          ? { contents: [{ parts }], generationConfig: { responseModalities: ["AUDIO"] } }
          : { contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: req.aspect_ratio ?? "1:1" } } },
      ),
      signal: AbortSignal.timeout(120_000),
    });
    const t = await res.text();
    if (!res.ok) return { ok: false, reason: classify(res.status, t), error: `gemini ${res.status}: ${t.slice(0, 200)}`, http_status: res.status };
    const j = JSON.parse(t) as { promptFeedback?: { blockReason?: string }; candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }> };
    if (j.promptFeedback?.blockReason) return { ok: false, reason: "refused", error: `gemini blocked: ${j.promptFeedback.blockReason}` };
    const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (!part?.data) return { ok: false, reason: "vendor_error", error: "gemini: no inline data" };
    if (isTts) {
      const wav = pcmToWav(Buffer.from(part.data, "base64")).toString("base64");
      return { ok: true, job: { vendor: "gemini", model, id: `inline-${Date.now()}`, inline: { url: `data:audio/wav;base64,${wav}`, mime: "audio/wav" } } };
    }
    const mime = part.mimeType ?? "image/png";
    return { ok: true, job: { vendor: "gemini", model, id: `inline-${Date.now()}`, inline: { url: `data:${mime};base64,${part.data}`, mime } } };
  } catch (e) {
    return { ok: false, reason: "vendor_error", error: `gemini: ${(e as Error).message}` };
  }
}
