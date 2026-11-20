import type { MediaFailReason, MediaRequest, SubmitResult } from "../types";
import { safeFetchImage } from "./safe-fetch";

const API = "https://api.openai.com/v1";
const SIZE: Record<string, string> = { "1:1": "1024x1024", "4:5": "1024x1536", "9:16": "1024x1536", "16:9": "1536x1024" };

function classify(status: number, body: string): MediaFailReason {
  const b = body.toLowerCase();
  if (b.includes("moderation") || b.includes("content_policy") || b.includes("safety")) return "refused";
  if (b.includes("insufficient_quota") || b.includes("billing")) return "out_of_credits";
  if (status === 401 || status === 403) return "not_configured";
  return "vendor_error";
}

export async function openaiSubmit(model: string, req: MediaRequest): Promise<SubmitResult> {
  const key = (process.env.OPENAI_API_KEY || "").trim();
  if (!key) return { ok: false, reason: "not_configured", error: "OPENAI_API_KEY not set" };
  const auth = { Authorization: `Bearer ${key}` };
  try {
    if (model.includes("tts")) {
      const res = await fetch(`${API}/audio/speech`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ model, voice: req.voice ?? "onyx", input: req.text ?? "", response_format: "mp3" }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) { const t = await res.text(); return { ok: false, reason: classify(res.status, t), error: `openai tts ${res.status}: ${t.slice(0, 200)}` }; }
      const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      return { ok: true, job: { vendor: "openai", model, id: `inline-${Date.now()}`, inline: { url: `data:audio/mpeg;base64,${b64}`, mime: "audio/mpeg" } } };
    }
    let res: Response;
    if (req.reference_url) {
      const img = await safeFetchImage(req.reference_url);
      if (!img) return { ok: false, reason: "vendor_error", error: "reference_url must be a public https image ≤10MB" };
      const ref = new Blob([img.bytes], { type: img.mime });
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", req.prompt ?? "");
      form.set("size", SIZE[req.aspect_ratio ?? "1:1"]);
      form.set("quality", "high");
      form.set("image", ref, "reference.png");
      res = await fetch(`${API}/images/edits`, { method: "POST", headers: auth, body: form, signal: AbortSignal.timeout(120_000) });
    } else {
      res = await fetch(`${API}/images/generations`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: req.prompt, size: SIZE[req.aspect_ratio ?? "1:1"], quality: "high", n: 1 }),
        signal: AbortSignal.timeout(120_000),
      });
    }
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: classify(res.status, text), error: `openai image ${res.status}: ${text.slice(0, 200)}`, http_status: res.status };
    const b64 = (JSON.parse(text) as { data?: Array<{ b64_json?: string }> }).data?.[0]?.b64_json;
    if (!b64) return { ok: false, reason: "vendor_error", error: "openai image: no b64_json" };
    return { ok: true, job: { vendor: "openai", model, id: `inline-${Date.now()}`, inline: { url: `data:image/png;base64,${b64}`, mime: "image/png" } } };
  } catch (e) {
    return { ok: false, reason: "vendor_error", error: `openai: ${(e as Error).message}` };
  }
}
