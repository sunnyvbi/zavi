
import {
  createSandbox,
  destroySandbox,
  execCommand,
  writeFile,
  type ExecResult,
} from "@/services/sandbox/e2b-client";
import { buildAss, buildFilterGraph, parseSilences, plainPlan, planFinish, OUT_H, OUT_W, type Word } from "./finish-plan";
import { FINISH_BUDGET_MS } from "./render-budget";

const WORK = "/home/user/finish";
const FONT_FILE = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const FONT_NAME = "DejaVu Sans";
const MAX_BYTES = 200 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 240_000;
const FETCH_TIMEOUT_MS = 110_000;
const ENCODE_TIMEOUT_MS = 180_000;
export { FINISH_BUDGET_MS };

export type FinishPassArgs = {
  tenant_id: string;
  rawUrl: string;
  uploadUrl: string;
  budgetMs?: number;
  words: Word[];
  videoSeconds?: number;
  hook?: string;
  stillOurs?: () => Promise<boolean>;
};

export type FinishPassResult =
  | { ok: true; duration_s: number; bytes: number }
  | { ok: false; reason: "no_plan" | "lease_lost" | "sandbox" | "deps" | "fetch" | "encode" | "verify" | "upload" | "timeout"; detail?: string };

export type FinishPassDeps = {
  create: typeof createSandbox;
  destroy: typeof destroySandbox;
  exec: typeof execCommand;
  write: typeof writeFile;
  now: () => number;
};

const REAL: FinishPassDeps = { create: createSandbox, destroy: destroySandbox, exec: execCommand, write: writeFile, now: () => Date.now() };

class OutOfTime extends Error {}

type Expected = { w: number; h: number; audio: boolean; duration: number };

const X264 = "-c:v libx264 -preset veryfast -crf 20 -maxrate 8M -bufsize 16M -pix_fmt yuv420p";

const tail = (r: ExecResult): string => (r.stderr || r.stdout || "").slice(-400);

function probed(stdout: string): { duration: number; width: number; height: number; streams: string[] } {
  const num = (k: string): number => Number((stdout.match(new RegExp(`^${k}=([0-9.]+)`, "m")) ?? [])[1]);
  return {
    duration: num("total"),
    width: num("width"),
    height: num("height"),
    streams: [...stdout.matchAll(/^codec_type=(\w+)/gm)].map((m) => m[1]),
  };
}

export async function runFinishPass(args: FinishPassArgs, deps: Partial<FinishPassDeps> = {}): Promise<FinishPassResult> {
  const d = { ...REAL, ...deps };
  const ours = async (): Promise<boolean> => (args.stillOurs ? args.stillOurs() : true);
  const deadline = d.now() + (args.budgetMs ?? FINISH_BUDGET_MS);
  const exec = (id: string, cmd: string, limitMs: number, opts?: Parameters<typeof execCommand>[3]): Promise<ExecResult> => {
    const left = deadline - d.now();
    if (left < 5_000) throw new OutOfTime();
    return d.exec(id, cmd, Math.min(limitMs, left), opts);
  };

  let sandboxId: string | null = null;
  try {
    try {
      sandboxId = await d.create({ tenant_id: args.tenant_id, repo_full_name: "zavi/video-finish", template: "praxis-large" });
    } catch (e) {
      return { ok: false, reason: "sandbox", detail: (e as Error).message.slice(0, 200) };
    }

    await exec(
      sandboxId,
      `mkdir -p ${WORK}/fonts && (command -v ffmpeg >/dev/null 2>&1 && test -f ${FONT_FILE} || ` +
        `(sudo apt-get update -y && sudo apt-get install -y ffmpeg fonts-dejavu-core)) >/dev/null 2>&1; ` +
        `cp ${FONT_FILE} ${WORK}/fonts/ 2>/dev/null; true`,
      INSTALL_TIMEOUT_MS,
    );
    const check = await exec(
      sandboxId,
      `command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 && test -f ${WORK}/fonts/DejaVuSans-Bold.ttf && ` +
        `ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' subtitles ' && echo DEPS_OK || echo DEPS_MISSING`,
      30_000,
    );
    if (!/\bDEPS_OK\b/.test(check.stdout)) return { ok: false, reason: "deps", detail: tail(check) };
    if (!(await ours())) return { ok: false, reason: "lease_lost" };

    const fetched = await exec(
      sandboxId,
      `cd ${WORK} && curl -fsSL --max-filesize ${MAX_BYTES} --max-time 100 -o in.mp4 "$RAW_URL" && test -s in.mp4`,
      FETCH_TIMEOUT_MS,
      { env: { RAW_URL: args.rawUrl } },
    );
    if (fetched.exit_code !== 0) return { ok: false, reason: "fetch", detail: tail(fetched) };

    const id = sandboxId;
    const fullEdit = async (): Promise<FinishPassResult | Expected> => {
      const heard = await exec(
        id,
        `cd ${WORK} && ffmpeg -hide_banner -nostats -i in.mp4 -vn -af silencedetect=n=-35dB:d=0.3 -f null - 2>&1 | grep -E 'silence_(start|end)' || true`,
        60_000,
      );
      const measured = await exec(id, `cd ${WORK} && ffprobe -v error -show_entries format=duration -of csv=p=0 in.mp4`, 30_000);
      const seconds = Number(measured.stdout.trim()) > 0 ? Number(measured.stdout.trim()) : (args.videoSeconds ?? 0);
      const plan = planFinish(args.words, seconds, parseSilences(heard.stdout)) ?? plainPlan(seconds);
      if (!plan) return { ok: false, reason: "no_plan" };

      await d.write(id, `${WORK}/captions.ass`, buildAss(plan, { hook: args.hook, font: FONT_NAME }));
      const graph = buildFilterGraph(plan);
      if (/['\\$`]/.test(graph)) return { ok: false, reason: "encode", detail: "filter graph failed its own safety check" };
      const encoded = await exec(
        id,
        `cd ${WORK} && ffmpeg -hide_banner -loglevel error -y -i in.mp4 -filter_complex '${graph}' -map '[v]' -map '[a]' -t ${plan.duration} ` +
          `${X264} -c:a aac -b:a 192k -ar 48000 -movflags +faststart out.mp4`,
        ENCODE_TIMEOUT_MS,
      );
      if (encoded.exit_code !== 0) return { ok: false, reason: "encode", detail: tail(encoded) };
      return { w: OUT_W, h: OUT_H, audio: true, duration: plan.duration };
    };

    const expect = await fullEdit();
    if ("ok" in expect) return expect;

    const probe = await exec(
      sandboxId,
      `cd ${WORK} && ffprobe -v error -show_entries stream=codec_type,width,height,duration -of default=noprint_wrappers=1 out.mp4 && ` +
        `echo "total=$(ffprobe -v error -show_entries format=duration -of csv=p=0 out.mp4)" && echo "bytes=$(stat -c %s out.mp4)" && ffmpeg -version | head -1`,
      30_000,
    );
    const p = probed(probe.stdout);
    const bytes = Number((probe.stdout.match(/^bytes=(\d+)/m) ?? [])[1]);
    const good =
      probe.exit_code === 0 &&
      p.width === expect.w &&
      p.height === expect.h &&
      p.streams.includes("video") &&
      (!expect.audio || p.streams.includes("audio")) &&
      Math.abs(p.duration - expect.duration) <= 0.75 &&
      bytes > 0 &&
      bytes <= MAX_BYTES;
    if (!good) return { ok: false, reason: "verify", detail: `planned=${expect.duration} ${probe.stdout.slice(0, 400)}` };
    if (!(await ours())) return { ok: false, reason: "lease_lost" };

    const uploaded = await exec(
      sandboxId,
      `cd ${WORK} && curl -fsS --max-time 100 -X PUT -H 'Content-Type: video/mp4' -H 'x-upsert: true' --data-binary @out.mp4 "$UPLOAD_URL" >/dev/null`,
      FETCH_TIMEOUT_MS,
      { env: { UPLOAD_URL: args.uploadUrl } },
    );
    if (uploaded.exit_code !== 0) return { ok: false, reason: "upload", detail: tail(uploaded) };
    return { ok: true, duration_s: p.duration, bytes };
  } catch (e) {
    if (e instanceof OutOfTime) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "sandbox", detail: (e as Error).message.slice(0, 200) };
  } finally {
    if (sandboxId) await d.destroy(sandboxId).catch(() => undefined);
  }
}
