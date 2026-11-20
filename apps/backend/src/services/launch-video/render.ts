
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  createSandbox,
  execCommand,
  writeFile,
  readFileBytes,
  destroySandbox,
} from "@/services/sandbox/e2b-client";
import type { VideoBrief, Aspect } from "./brief-mapper";
import type { BeatAudio } from "./vo";
import type { GeneratedImage, GeneratedVideo } from "./media";

const PKG_DIR = "/home/user/launch-video";
const PUBLIC_DIR = `${PKG_DIR}/public`;
const ENGINE_TGZ_SANDBOX = "/home/user/launch-video-engine.tgz";
const NPM_TIMEOUT_MS = 600_000;
const RENDER_TIMEOUT_MS = 600_000;

const FPS = 30;
const VO_TAIL_FRAMES = 15;
const DEFAULT_BEAT_FRAMES: Record<string, number> = {
  hook: 135,
  problem: 150,
  feature: 150,
  proof: 150,
  cta: 135,
  chat: 180,
  cardwall: 150,
  metric: 180,
  productui: 180,
  coverage: 150,
  broll: 180,
};

export class LaunchVideoRenderError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "LaunchVideoRenderError";
  }
}

export type RenderResult = { bytes: Uint8Array; voicedBeats: number };

export type AspectRenderResult = {
  aspect: Aspect;
  bytes: Uint8Array;
  voicedBeats: number;
  previewBytes?: Uint8Array;
};

export type WatermarkSpec = { text: string; maxWidth?: number };

const WATERMARK_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

const PREVIEW_MAX_WIDTH = 1280;
const PREVIEW_CRF = 20;

export type RenderLaunchVideoArgs = {
  tenant_id: string;
  brief: VideoBrief;
  audio: Map<number, BeatAudio>;
  images?: GeneratedImage[];
  videos?: GeneratedVideo[];
};

export function resolveEngineTarball(): Buffer {
  const explicit = (process.env.LAUNCH_VIDEO_ENGINE_TGZ || "").trim();
  const prebuilt = explicit || join(process.cwd(), "launch-video-engine.tgz");
  if (existsSync(prebuilt)) {
    return readFileSync(prebuilt);
  }

  const srcDir = findEngineSourceDir();
  if (!srcDir) {
    throw new LaunchVideoRenderError(
      "engine_tarball_missing",
      `launch-video engine tarball not found at ${prebuilt} and no workspace source resolvable — ` +
        `the Docker image build must produce launch-video-engine.tgz (see Dockerfile).`,
    );
  }
  const out = join(mkdtempSync(join(tmpdir(), "lv-engine-")), "engine.tgz");
  execFileSync("tar", ["czf", out, "-C", srcDir, "--exclude=node_modules", "--exclude=out", "."]);
  return readFileSync(out);
}

function findEngineSourceDir(): string | null {
  const candidates = [
    resolve(process.cwd(), "../../packages/launch-video"),
    resolve(process.cwd(), "packages/launch-video"),
    resolve(__dirname, "../../../../../packages/launch-video"),
    resolve(__dirname, "../../../../packages/launch-video"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "scripts", "render.mjs"))) return c;
  }
  return null;
}

export async function renderLaunchVideo(args: RenderLaunchVideoArgs): Promise<RenderResult> {
  const { results } = await renderLaunchVideoAspects({ ...args, aspects: [args.brief.aspect ?? "16:9"] });
  const first = results[0];
  if (!first) throw new LaunchVideoRenderError("render_empty", "no aspect was rendered");
  return { bytes: first.bytes, voicedBeats: first.voicedBeats };
}

export async function renderLaunchVideoAspects(
  args: RenderLaunchVideoArgs & {
    aspects: Aspect[];
    watermark?: WatermarkSpec;
    authoredTsx?: string;
    authoredFrames?: number;
    gateThemeFilm?: boolean;
  },
): Promise<{ results: AspectRenderResult[] }> {
  const engineTgz = resolveEngineTarball();
  const images = args.images ?? [];
  const videos = args.videos ?? [];
  const aspects: Aspect[] = [...new Set(args.aspects.length > 0 ? args.aspects : [args.brief.aspect ?? "16:9"])];

  const brief: VideoBrief = {
    ...args.brief,
    beats: args.brief.beats.map((b, i) => {
      const a = args.audio.get(i);
      return a ? { ...b, vo: { ...(b.vo ?? {}), audioFile: `vo_${i}.${a.ext}` } } : { ...b };
    }),
  };
  for (const img of images) {
    const beat = brief.beats[img.beatIndex] as
      | { kind: string; image?: string; items?: Array<{ image?: string }> }
      | undefined;
    if (!beat) continue;
    if (img.itemIndex == null) {
      beat.image = img.filename;
    } else if (beat.items && beat.items[img.itemIndex]) {
      beat.items = beat.items.map((it, j) => (j === img.itemIndex ? { ...it, image: img.filename } : it));
    }
  }
  for (const vid of videos) {
    const beat = brief.beats[vid.beatIndex] as { kind: string; video?: string } | undefined;
    if (beat?.kind === "broll") beat.video = vid.filename;
  }
  brief.beats = brief.beats.filter((b) => b.kind !== "broll" || Boolean((b as { video?: string }).video));

  let sandboxId: string | null = null;
  try {
    sandboxId = await createSandbox({
      tenant_id: args.tenant_id,
      repo_full_name: "zavi/launch-video",
      template: "praxis-large",
    });

    await writeBytes(sandboxId, ENGINE_TGZ_SANDBOX, engineTgz);
    const extract = await execCommand(
      sandboxId,
      `mkdir -p ${PKG_DIR} && tar xzf ${ENGINE_TGZ_SANDBOX} -C ${PKG_DIR}`,
      120_000,
    );
    if (extract.exit_code !== 0) {
      throw new LaunchVideoRenderError("extract_failed", tail(extract.stderr || extract.stdout));
    }

    if (args.authoredTsx) {
      await writeFile(sandboxId, `${PKG_DIR}/src/Authored.tsx`, args.authoredTsx);
    }

    await execCommand(
      sandboxId,
      `command -v ffmpeg >/dev/null 2>&1 || (sudo apt-get update -y && sudo apt-get install -y ffmpeg) || true`,
      300_000,
    );

    if (args.watermark) {
      await execCommand(
        sandboxId,
        `command -v ffmpeg >/dev/null 2>&1 || (sudo apt-get update -y && sudo apt-get install -y ffmpeg); ` +
          `(test -f ${WATERMARK_FONT} || (sudo apt-get update -y && sudo apt-get install -y fonts-dejavu-core)) || true`,
        300_000,
      );
      const check = await execCommand(
        sandboxId,
        `command -v ffmpeg >/dev/null 2>&1 && test -f ${WATERMARK_FONT} && echo OK || echo MISSING`,
        30_000,
      );
      if (!/\bOK\b/.test(check.stdout)) {
        throw new LaunchVideoRenderError(
          "watermark_deps_missing",
          "ffmpeg or the watermark font is unavailable in the sandbox — refusing to serve an un-watermarked preview",
        );
      }
    }

    const install = await execCommand(sandboxId, `cd ${PKG_DIR} && (npm ci || npm i)`, NPM_TIMEOUT_MS);
    if (install.exit_code !== 0) {
      throw new LaunchVideoRenderError("npm_install_failed", tail(install.stderr || install.stdout));
    }

    if (images.length > 0 || videos.length > 0) {
      await execCommand(sandboxId, `mkdir -p ${PUBLIC_DIR}`, 30_000);
      for (const img of images) {
        try {
          await writeBytes(sandboxId, `${PUBLIC_DIR}/${img.filename}`, img.bytes);
        } catch (e) {
          console.warn(`[launch-video/render] image inject failed for ${img.filename} (glyph fallback): ${(e as Error).message}`);
          stripImageRef(brief, img);
        }
      }
      for (const vid of videos) {
        try {
          await writeBytes(sandboxId, `${PUBLIC_DIR}/${vid.filename}`, vid.bytes);
        } catch (e) {
          console.warn(`[launch-video/render] b-roll inject failed for ${vid.filename} (drop beat): ${(e as Error).message}`);
          const beat = brief.beats[vid.beatIndex] as { kind?: string; video?: string } | undefined;
          if (beat?.kind === "broll") delete beat.video;
        }
      }
      brief.beats = brief.beats.filter((b) => b.kind !== "broll" || Boolean((b as { video?: string }).video));
    }

    let voicedBeats = 0;
    for (const [i, a] of args.audio) {
      await writeBytes(sandboxId, `${PKG_DIR}/vo_${i}.${a.ext}`, a.bytes);
      voicedBeats++;
    }

    await applyVoMinDurations(sandboxId, brief, args.audio);

    await execCommand(sandboxId, `mkdir -p ${PKG_DIR}/out`, 30_000);

    const results: AspectRenderResult[] = [];
    for (let idx = 0; idx < aspects.length; idx++) {
      const aspect = aspects[idx];
      const briefFile = `brief_${idx}.json`;
      const outFile = `out/video_${idx}.mp4`;
      await writeFile(
        sandboxId,
        `${PKG_DIR}/${briefFile}`,
        JSON.stringify(
          args.authoredTsx
            ? { ...brief, aspect, authored: true, authoredFrames: args.authoredFrames ?? null }
            : { ...brief, aspect },
        ),
      );
      if (args.authoredTsx) {
        const browser = await execCommand(sandboxId, `cd ${PKG_DIR} && npx remotion browser ensure`, 300_000);
        if (browser.exit_code !== 0) {
          // eslint-disable-next-line no-console
          console.warn(`[launch-video] could not pre-fetch the render browser: ${tail(browser.stderr || browser.stdout)}`);
        }
      }

      if (args.authoredTsx) {
        const lockdown = await execCommand(
          sandboxId,
          `sudo iptables -A OUTPUT -o lo -j ACCEPT && sudo iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT && sudo iptables -P OUTPUT DROP && echo EGRESS_DROPPED`,
          60_000,
        );
        if (!/EGRESS_DROPPED/.test(lockdown.stdout)) {
          throw new LaunchVideoRenderError(
            "authored_lockdown_failed",
            `could not drop sandbox egress before an authored render, so the film was not run: ${tail(lockdown.stderr || lockdown.stdout)}`,
          );
        }
        // eslint-disable-next-line no-console
        console.info("[launch-video] sandbox egress dropped before the authored render");
      }

      if (args.authoredTsx && args.gateThemeFilm && idx === 0) {
        const gate = await execCommand(sandboxId, `cd ${PKG_DIR} && node scripts/gate-film.mjs --sample`, 300_000);
        if (gate.exit_code === 1) {
          let reasons: string[] = ["the film failed the sample gate"];
          try {
            const parsed = JSON.parse(gate.stdout.slice(gate.stdout.indexOf("{"))) as { reasons?: unknown };
            if (Array.isArray(parsed.reasons)) reasons = parsed.reasons.map(String).slice(0, 20);
          } catch {
          }
          throw new LaunchVideoRenderError("film_gate_failed", JSON.stringify(reasons));
        }
        if (gate.exit_code !== 0) {
          // eslint-disable-next-line no-console
          console.warn(`[launch-video] film gate could not run, rendering anyway: ${tail(gate.stderr || gate.stdout)}`);
        }
      }

      const render = await execCommand(
        sandboxId,
        `cd ${PKG_DIR} && node scripts/render.mjs --brief ${briefFile} --out ${outFile}`,
        RENDER_TIMEOUT_MS,
      );
      if (render.exit_code !== 0) {
        throw new LaunchVideoRenderError("render_failed", `[${aspect}] ${tail(render.stderr || render.stdout)}`);
      }
      const bytes = await readFileBytes(sandboxId, `${PKG_DIR}/${outFile}`);
      if (!bytes || bytes.byteLength === 0) {
        throw new LaunchVideoRenderError("render_empty", `render produced no mp4 bytes for ${aspect}`);
      }

      let previewBytes: Uint8Array | undefined;
      if (args.watermark) {
        previewBytes = await watermarkPreview(sandboxId, `${PKG_DIR}/${outFile}`, idx, args.watermark);
      }

      results.push({ aspect, bytes, voicedBeats, previewBytes });
    }
    return { results };
  } finally {
    if (sandboxId) {
      try {
        await destroySandbox(sandboxId);
      } catch (e) {
        console.warn(`[launch-video/render] destroySandbox failed (non-fatal): ${(e as Error).message}`);
      }
    }
  }
}

function escapeDrawText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%");
}

export function buildPreviewFilterChain(spec: WatermarkSpec): string {
  const w = Math.max(160, Math.min(1280, spec.maxWidth ?? PREVIEW_MAX_WIDTH));
  const text = escapeDrawText(spec.text);
  return [
    `scale=${w}:-2`,
    `drawtext=fontfile=${WATERMARK_FONT}:text='${text}':fontcolor=white@0.85:fontsize=h/26:x=w-text_w-16:y=h-text_h-16:box=1:boxcolor=black@0.35:boxborderw=6`,
  ].join(",");
}

async function watermarkPreview(
  sandboxId: string,
  inPath: string,
  idx: number,
  spec: WatermarkSpec,
): Promise<Uint8Array> {
  const outPath = `${PKG_DIR}/out/preview_${idx}.mp4`;
  const vf = buildPreviewFilterChain(spec);
  const r = await execCommand(
    sandboxId,
    `cd ${PKG_DIR} && ffmpeg -y -i '${inPath}' -vf "${vf}" -c:v libx264 -preset veryfast -crf ${PREVIEW_CRF} -c:a copy -movflags +faststart '${outPath}'`,
    300_000,
  );
  if (r.exit_code !== 0) {
    throw new LaunchVideoRenderError("watermark_failed", tail(r.stderr || r.stdout));
  }
  const bytes = await readFileBytes(sandboxId, outPath);
  if (!bytes || bytes.byteLength === 0) {
    throw new LaunchVideoRenderError("watermark_empty", "watermark produced no mp4 bytes");
  }
  return bytes;
}

async function writeBytes(sandboxId: string, path: string, bytes: Uint8Array): Promise<void> {
  const b64 = Buffer.from(bytes).toString("base64");
  await writeFile(sandboxId, `${path}.b64`, b64);
  const r = await execCommand(sandboxId, `base64 -d '${path}.b64' > '${path}' && rm -f '${path}.b64'`, 60_000);
  if (r.exit_code !== 0) {
    throw new LaunchVideoRenderError("bytes_write_failed", tail(r.stderr));
  }
}

function stripImageRef(brief: VideoBrief, img: GeneratedImage): void {
  const beat = brief.beats[img.beatIndex] as { image?: string; items?: Array<{ image?: string }> } | undefined;
  if (!beat) return;
  if (img.itemIndex == null) delete beat.image;
  else if (beat.items?.[img.itemIndex]) delete beat.items[img.itemIndex].image;
}

function tail(s: string, n = 600): string {
  if (!s) return "";
  return s.length > n ? `…${s.slice(-n)}` : s;
}

async function applyVoMinDurations(
  sandboxId: string,
  brief: VideoBrief,
  audio: Map<number, BeatAudio>,
): Promise<void> {
  for (const [i, a] of audio) {
    const beat = brief.beats[i] as { kind: string; durationFrames?: number } | undefined;
    if (!beat) continue;
    const sec = await probeAudioSeconds(sandboxId, `${PKG_DIR}/vo_${i}.${a.ext}`);
    if (sec == null) continue;
    const current =
      beat.durationFrames && beat.durationFrames > 0
        ? beat.durationFrames
        : DEFAULT_BEAT_FRAMES[beat.kind] ?? 150;
    const needed = Math.ceil(sec * FPS) + VO_TAIL_FRAMES;
    beat.durationFrames = Math.max(current, needed);
  }
}

async function probeAudioSeconds(sandboxId: string, path: string): Promise<number | null> {
  try {
    const r = await execCommand(
      sandboxId,
      `ffprobe -v error -show_entries format=duration -of default=nw=1:nokey=1 '${path}' 2>/dev/null || true`,
      30_000,
    );
    const sec = parseFloat((r.stdout || "").trim());
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  } catch {
    return null;
  }
}
