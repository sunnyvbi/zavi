
import { pathToFileURL } from "node:url";

export const ACTIVE_ROUTES = {
  "image.photo": "bytedance/seedream/v5/pro/text-to-image",
  "image.plate": "bytedance/seedream/v5/pro/text-to-image",
  "image.hero": "bytedance/seedream/v5/pro/text-to-image",
  "image.text": "openai/gpt-image-2.5/sunburst/text-to-image",
  "image.edit": "openai/gpt-image-2.5/flare/edit",
  "image.vector": "fal-ai/recraft/v4.1/text-to-vector",
  "image.draft": "fal-ai/flux-2/klein/4b",
  "video.broll": "bytedance/seedance-2.5/text-to-video",
  "video.cinematic": "bytedance/seedance-2.5/text-to-video",
  "video.social": "bytedance/seedance-2.5/text-to-video",
  "video.animate": "bytedance/seedance-2.5/image-to-video",
  "video.talking_head": "fal-ai/kling-video/ai-avatar/v2/pro",
  "video.talking_head_long": "fal-ai/kling-video/ai-avatar/v2/pro",
  "video.talking_head_standard": "fal-ai/kling-video/ai-avatar/v2/standard",
  "video.edit": "alibaba/wan-3.0/reference-to-video",
  "audio.voiceover": "elevenlabs/tts/eleven-v4",
};

const ALTERNATE_PRICE_IDS = [
  "openai/gpt-image-2.5/flare/text-to-image",
  "bytedance/seedream/v5/pro/edit",
  "bytedance/seedance-2.5/reference-to-video",
  "bytedance/seedance-2.0/text-to-video",
  "alibaba/wan-3.0/text-to-video",
  "alibaba/wan-3.0/image-to-video",
  "google/gemini-omni-flash/v1.1/text-to-video",
  "minimax/h3/image-to-video",
  "fal-ai/bytedance/omnihuman/v1.5",
  "veed/fabric-1.0",
  "fal-ai/recraft/v4/text-to-vector",
  "fal-ai/elevenlabs/tts/eleven-v3",
];

export const PRICE_IDS = [...new Set([...Object.values(ACTIVE_ROUTES), ...ALTERNATE_PRICE_IDS])];

const AVATAR_PROMPT = "The presenter talks directly to the camera in a natural, friendly way, with subtle head movement and natural blinks.";
const SQUARE = { width: 1024, height: 1024 };

const INPUTS = {
  "bytedance/seedream/v5/pro/text-to-image": { produces: "still", input: () => ({ prompt: "a red bicycle against a white wall", image_size: SQUARE, num_images: 1 }) },
  "openai/gpt-image-2.5/sunburst/text-to-image": { input: () => ({ prompt: "a poster with the single word OPEN in bold type", image_size: "square_hd", quality: "low", num_images: 1 }) },
  "openai/gpt-image-2.5/flare/edit": { needs: ["still"], input: (r) => ({ prompt: "make the wall pale blue", image_size: "square_hd", quality: "low", num_images: 1, image_urls: [r.still] }) },
  "fal-ai/recraft/v4.1/text-to-vector": { input: () => ({ prompt: "a simple mountain logo mark, flat vector" }) },
  "fal-ai/flux-2/klein/4b": { input: () => ({ prompt: "a cup of coffee on a table" }) },
  "bytedance/seedance-2.5/text-to-video": { produces: "clip", input: () => ({ prompt: "waves rolling onto a beach at sunset", duration: "4", resolution: "480p", aspect_ratio: "16:9", generate_audio: true }) },
  "bytedance/seedance-2.5/image-to-video": { needs: ["still"], input: (r) => ({ prompt: "slow push in", image_url: r.still, duration: "4", resolution: "480p", generate_audio: true }) },
  "fal-ai/kling-video/ai-avatar/v2/pro": { needs: ["portrait", "voice"], input: (r) => ({ image_url: r.portrait, audio_url: r.voice, prompt: AVATAR_PROMPT }) },
  "fal-ai/kling-video/ai-avatar/v2/standard": { needs: ["portrait", "voice"], input: (r) => ({ image_url: r.portrait, audio_url: r.voice, prompt: AVATAR_PROMPT }) },
  "alibaba/wan-3.0/reference-to-video": { needs: ["clip"], input: (r) => ({ prompt: "the same scene in black and white", resolution: "720p", aspect_ratio: "16:9", duration: 2, audio: true, reference_video_urls: [r.clip] }) },
  "elevenlabs/tts/eleven-v4": { produces: "voice", input: () => ({ text: "Hello from Zavi. This is a short voice check for the media router.", voice: "Brian" }) },
};

const EXTRA_STEPS = [
  { id: "bytedance/seedream/v5/pro/text-to-image", label: "seedream portrait (for the chained checks)", produces: "portrait", input: () => ({ prompt: "photoreal upper-body portrait of a person presenting to camera, studio lighting", image_size: SQUARE, num_images: 1 }) },
  { id: "fal-ai/bytedance/omnihuman/v1.5", label: "fal-ai/bytedance/omnihuman/v1.5 (talking head fallback)", needs: ["portrait", "voice"], input: (r) => ({ image_url: r.portrait, audio_url: r.voice, resolution: "720p" }) },
  { id: "bytedance/seedance-2.5/text-to-video", label: "bytedance/seedance-2.5/text-to-video @720p", input: () => ({ prompt: "a city street at golden hour", duration: "4", resolution: "720p", aspect_ratio: "16:9", generate_audio: true }) },
];

function tasksFor(id) {
  return Object.entries(ACTIVE_ROUTES).filter(([, m]) => m === id).map(([t]) => t);
}

export function generateSteps() {
  const active = [...new Set(Object.values(ACTIVE_ROUTES))].map((id) => {
    const spec = INPUTS[id];
    const label = `${id} (${tasksFor(id).join(", ")})`;
    return spec ? { id, label, ...spec } : { id, label, missing: true };
  });
  const steps = [...active, ...EXTRA_STEPS];
  const rank = (s) => (s.needs?.length ? 1 : 0);
  return steps.slice().sort((a, b) => rank(a) - rank(b));
}

function outputUrl(out) {
  return out?.images?.[0]?.url ?? out?.image?.url ?? out?.video?.url ?? out?.audio?.url ?? null;
}

export async function main({ fetch = globalThis.fetch, key = process.env.FAL_KEY, argv = process.argv.slice(2), log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 5000, maxPolls = 120 } = {}) {
  const FAL = (key || "").trim();
  if (!FAL) {
    log("FAL_KEY missing — add it to apps/backend/.env first");
    return 1;
  }
  const QUEUE = "https://queue.fal.run";
  const H = {
    Authorization: `Key ${FAL}`,
    "Content-Type": "application/json",
    "X-Fal-Object-Lifecycle-Preference": JSON.stringify({ expiration_duration_seconds: 3600 }),
    "X-Fal-Store-IO": "0",
  };
  const AUTH = { Authorization: `Key ${FAL}` };
  const results = [];
  const record = (id, ok, detail) => {
    results.push({ id, ok, detail });
    log(`${ok ? "PASS" : "FAIL"} ${id} ${detail}`);
  };

  const priceUrl = `https://api.fal.ai/v1/models/pricing?${PRICE_IDS.map((i) => `endpoint_id=${encodeURIComponent(i)}`).join("&")}`;
  let pr;
  let priceBody;
  try {
    pr = await fetch(priceUrl, { headers: AUTH });
    priceBody = await pr.text();
  } catch (e) {
    log(`\n── PRICING FAILED: ${e.message} ──`);
    return 1;
  }
  log(`\n── PRICING (${pr.status}) ──\n${priceBody}\n`);
  if (!pr.ok) {
    log(`PRICING FAILED with ${pr.status}: check FAL_KEY before trusting any price`);
    return 1;
  }
  let prices;
  try {
    prices = JSON.parse(priceBody).prices;
  } catch {
    prices = null;
  }
  if (!Array.isArray(prices)) {
    log("PRICING FAILED: the reply has no prices list");
    return 1;
  }
  const priceOf = new Map(prices.map((p) => [p.endpoint_id, p]));
  const unpriced = [];
  for (const [task, id] of Object.entries(ACTIVE_ROUTES)) {
    const p = priceOf.get(id);
    if (p && typeof p.unit_price === "number") {
      log(`PASS ${task} ${id} ${p.unit_price} ${p.currency ?? "USD"} per ${p.unit ?? "unit"}`);
    } else {
      unpriced.push(task);
      log(`FAIL ${task} ${id} no price returned`);
    }
  }
  if (unpriced.length) {
    log(`\nPRICING FAILED: no price for ${unpriced.join(", ")}. Check the model id and that the account can call it.`);
    return 1;
  }

  if (!argv.includes("--generate")) {
    log("prices only — re-run with --generate to prove every route actually generates");
    return 0;
  }

  async function run(id, label, input) {
    const s = await fetch(`${QUEUE}/${id}`, { method: "POST", headers: H, body: JSON.stringify(input) });
    const stext = await s.text();
    if (!s.ok) {
      record(label, false, `submit ${s.status}: ${stext.slice(0, 200)}`);
      return null;
    }
    const { status_url, response_url } = JSON.parse(stext);
    for (let i = 0; i < maxPolls; i++) {
      await sleep(pollMs);
      const st = await fetch(status_url, { headers: AUTH });
      if (!st.ok) continue;
      const { status } = await st.json();
      if (status !== "COMPLETED") continue;
      const r = await fetch(response_url, { headers: AUTH });
      const rtext = await r.text();
      if (!r.ok) {
        record(label, false, `result ${r.status}: ${rtext.slice(0, 200)}`);
        return null;
      }
      return JSON.parse(rtext);
    }
    record(label, false, `poll timeout after ${(maxPolls * pollMs) / 1000}s`);
    return null;
  }

  async function verify(label, out) {
    const url = outputUrl(out);
    if (!url) {
      record(label, false, `no output url in ${JSON.stringify(out).slice(0, 160)}`);
      return null;
    }
    const f = await fetch(url);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const ok = f.ok && bytes.byteLength > 0;
    record(label, ok, `${f.headers.get("content-type")} ${bytes.byteLength}B`);
    return ok ? url : null;
  }

  const refs = {};
  for (const step of generateSteps()) {
    if (step.missing) {
      record(step.label, false, "no live-check input for this active route: add one to INPUTS");
      continue;
    }
    const lacking = (step.needs ?? []).filter((n) => !refs[n]);
    if (lacking.length) {
      record(step.label, false, `not run: no ${lacking.join(" / ")} from an earlier step`);
      continue;
    }
    const out = await run(step.id, step.label, step.input(refs));
    const url = out ? await verify(step.label, out) : null;
    if (url && step.produces && !refs[step.produces]) refs[step.produces] = url;
  }

  const failed = results.filter((r) => !r.ok);
  log(`\n── SUMMARY: ${results.length - failed.length}/${results.length} PASS ──`);
  for (const f of failed) log(`  FAIL ${f.id}: ${f.detail}`);
  log(
    failed.length === 0
      ? "\nEvery active route generated real bytes. Update prices.ts from the PRICING block above."
      : "\nFix the table (or get fal to approve the account) before deploying: a FAILING active route means that customer action is dead.",
  );
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
