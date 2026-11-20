import { describe, it, expect, vi } from "vitest";
import { runFinishPass, type FinishPassDeps } from "../finish-pass";
import type { Word } from "../finish-plan";

const WORDS: Word[] = [["Most", 0.1, 0.4], ["bouquets", 0.45, 0.9], ["die", 0.95, 1.2], ["fast.", 1.25, 1.6], ["Ours", 2.2, 2.5], ["do", 2.55, 2.7], ["not.", 2.75, 3.1]];
const RAW = "https://storage.test/get/raw.mp4?sig=RAWURLMARKER";
const PUT = "https://storage.test/put/edited.mp4?sig=PUTURLMARKER";

type Call = { cmd: string; env?: Record<string, string>; limit?: number };

function fakeSandbox(over: Partial<Record<"deps" | "fetch" | "listen" | "measure" | "encode" | "probe" | "upload", { stdout?: string; exit_code?: number }>> & { eachTakesMs?: number } = {}) {
  const calls: Call[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const destroyed: string[] = [];
  const clock = { t: 1_000_000 };
  const res = (r: { stdout?: string; exit_code?: number } = {}) => ({ stdout: r.stdout ?? "", stderr: "", exit_code: r.exit_code ?? 0, ms: 1 });
  const deps: FinishPassDeps = {
    now: () => clock.t,
    create: vi.fn(async () => "sbx_1"),
    destroy: vi.fn(async (id: string) => void destroyed.push(id)),
    write: vi.fn(async (_id: string, path: string, content: string) => void writes.push({ path, content })),
    exec: vi.fn(async (_id: string, cmd: string, _t?: number, opts?: { env?: Record<string, string> }) => {
      calls.push({ cmd, env: opts?.env, limit: _t });
      clock.t += over.eachTakesMs ?? 1_000;
      if (cmd.includes("DEPS_OK")) return res(over.deps ?? { stdout: "DEPS_OK\n" });
      if (cmd.includes("-o in.mp4")) return res(over.fetch);
      if (cmd.includes("silencedetect")) return res(over.listen);
      if (cmd.includes("format=duration -of csv=p=0 in.mp4")) return res(over.measure ?? { stdout: "3.600000\n" });
      if (cmd.includes("-filter_complex")) return res(over.encode);
      if (cmd.includes("ffprobe")) {
        return res(over.probe ?? { stdout: "codec_type=video\nwidth=1080\nheight=1920\ncodec_type=audio\ntotal=3.170000\nbytes=123456\n" });
      }
      if (cmd.includes("-X PUT")) return res(over.upload);
      return res();
    }) as unknown as FinishPassDeps["exec"],
  };
  return { deps, calls, writes, destroyed };
}

const args = (over: Record<string, unknown> = {}) => ({ tenant_id: "t1", rawUrl: RAW, uploadUrl: PUT, words: WORDS, videoSeconds: 3.6, hook: "Most bouquets die fast", ...over });

describe("runFinishPass", () => {
  it("fetches the raw video, encodes it with captions, checks the result, uploads it, and always destroys the sandbox", async () => {
    const sb = fakeSandbox();
    const r = await runFinishPass(args(), sb.deps);
    expect(r).toEqual({ ok: true, duration_s: 3.17, bytes: 123456 });
    const order = sb.calls.map((c) => (c.cmd.includes("DEPS_OK") ? "check" : c.cmd.includes("-o in.mp4") ? "fetch" : c.cmd.includes("silencedetect") ? "listen" : c.cmd.includes("csv=p=0 in.mp4") ? "measure" : c.cmd.includes("-filter_complex") ? "encode" : c.cmd.includes("ffprobe") ? "probe" : c.cmd.includes("-X PUT") ? "upload" : "install"));
    expect(order).toEqual(["install", "check", "fetch", "listen", "measure", "encode", "probe", "upload"]);
    expect(sb.calls.find((c) => c.cmd.includes("-filter_complex"))!.cmd).toMatch(/-t \d+(\.\d+)? /);
    expect(sb.writes).toHaveLength(1);
    expect(sb.writes[0].path).toMatch(/captions\.ass$/);
    expect(sb.writes[0].content).toContain("MOST BOUQUETS DIE");
    expect(sb.writes[0].content).not.toMatch(/AI-generated|,Label,/i);
    expect(sb.destroyed).toEqual(["sbx_1"]);
  });

  it("the signed URLs and the customer's words never appear in a command string", async () => {
    const sb = fakeSandbox();
    await runFinishPass(args({ hook: "it's $(rm -rf /) `whoami`" }), sb.deps);
    for (const c of sb.calls) {
      expect(c.cmd).not.toContain("RAWURLMARKER");
      expect(c.cmd).not.toContain("PUTURLMARKER");
      expect(c.cmd).not.toContain("whoami");
      expect(c.cmd).not.toMatch(/BOUQUETS/i);
    }
    expect(sb.calls.find((c) => c.cmd.includes("-o in.mp4"))!.env).toEqual({ RAW_URL: RAW });
    expect(sb.calls.find((c) => c.cmd.includes("-X PUT"))!.env).toEqual({ UPLOAD_URL: PUT });
  });

  it.each([
    ["deps", { deps: { stdout: "DEPS_MISSING\n" } }],
    ["fetch", { fetch: { exit_code: 22 } }],
    ["encode", { encode: { exit_code: 1 } }],
    ["verify", { probe: { stdout: "codec_type=video\nwidth=1080\nheight=1920\ntotal=3.170000\nbytes=123456\n" } }],
    ["verify", { probe: { stdout: "codec_type=video\nwidth=704\nheight=1248\ncodec_type=audio\ntotal=3.17\nbytes=123456\n" } }],
    ["verify", { probe: { stdout: "codec_type=video\nwidth=1080\nheight=1920\ncodec_type=audio\ntotal=9.0\nbytes=123456\n" } }],
    ["upload", { upload: { exit_code: 22 } }],
  ] as const)("a %s failure is reported, nothing is uploaded after it, and the sandbox is destroyed", async (reason, over) => {
    const sb = fakeSandbox(over);
    const r = await runFinishPass(args(), sb.deps);
    expect(r).toMatchObject({ ok: false, reason });
    if (reason !== "upload") expect(sb.calls.some((c) => c.cmd.includes("-X PUT"))).toBe(false);
    expect(sb.destroyed).toEqual(["sbx_1"]);
  });

  it("stops without uploading when the card is taken over mid-pass", async () => {
    const sb = fakeSandbox();
    let asked = 0;
    const r = await runFinishPass(args({ stillOurs: async () => ++asked < 2 }), sb.deps);
    expect(r).toEqual({ ok: false, reason: "lease_lost" });
    expect(sb.calls.some((c) => c.cmd.includes("-X PUT"))).toBe(false);
    expect(sb.destroyed).toEqual(["sbx_1"]);
  });

  it("tightens the pause it hears in the audio, which the word timings do not show", async () => {
    const stretched: Word[] = WORDS.map((w) => (w[0] === "fast." ? ["fast.", 1.25, 2.2] : w));
    const deaf = fakeSandbox();
    await runFinishPass(args({ words: stretched }), deaf.deps);
    const hearing = fakeSandbox({ listen: { stdout: "[silencedetect @ 0x1] silence_start: 1.62\n[silencedetect @ 0x1] silence_end: 2.18 | silence_duration: 0.56\n" } });
    await runFinishPass(args({ words: stretched }), hearing.deps);
    const capOf = (sb: ReturnType<typeof fakeSandbox>) => Number(sb.calls.find((c) => c.cmd.includes("-filter_complex"))!.cmd.match(/-t (\d+(?:\.\d+)?) /)![1]);
    expect(capOf(hearing)).toBeCloseTo(capOf(deaf) - (0.56 - 0.24), 2);
  });

  it("gives up inside its time budget, so the step that runs it is never killed mid-pass", async () => {
    const sb = fakeSandbox({ eachTakesMs: 180_000 });
    const r = await runFinishPass(args(), sb.deps);
    expect(r).toEqual({ ok: false, reason: "timeout" });
    expect(sb.calls.some((c) => c.cmd.includes("-X PUT"))).toBe(false);
    expect(sb.destroyed).toEqual(["sbx_1"]);
    let left = 8 * 60 * 1000;
    for (const c of sb.calls) {
      expect(c.limit!).toBeLessThanOrEqual(left);
      left -= 180_000;
    }
  });

  it("with no usable word timings, still burns in the title and no label: no captions, nothing cut", async () => {
    const sb = fakeSandbox({ probe: { stdout: "codec_type=video\nwidth=1080\nheight=1920\ncodec_type=audio\ntotal=3.600000\nbytes=123456\n" } });
    const r = await runFinishPass(args({ words: [] }), sb.deps);
    expect(r).toMatchObject({ ok: true, duration_s: 3.6 });
    const ass = sb.writes[0].content;
    expect(ass).not.toMatch(/AI-generated|,Label,/i);
    expect(ass).toContain(",Hook,");
    expect(ass).not.toContain(",Cap,,");
    expect(sb.calls.find((c) => c.cmd.includes("-filter_complex"))!.cmd).toContain("concat=n=1:v=1:a=1");
  });

  it("plans from the length of the file itself, not the vendor's figure", async () => {
    const sb = fakeSandbox();
    expect(await runFinishPass(args({ videoSeconds: 9 }), sb.deps)).toMatchObject({ ok: true });
    expect(sb.writes[0].content).toContain(",Cap,,");
  });

  it("a file it cannot measure and no vendor length is a failed pass, not a guess", async () => {
    const sb = fakeSandbox({ measure: { stdout: "N/A\n" } });
    expect(await runFinishPass(args({ videoSeconds: undefined }), sb.deps)).toEqual({ ok: false, reason: "no_plan" });
    expect(sb.calls.some((c) => c.cmd.includes("-X PUT"))).toBe(false);
  });

  it("a sandbox that cannot be created, or that throws mid-way, is a failed pass and not an exception", async () => {
    const down = fakeSandbox();
    (down.deps.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("e2b down"));
    expect(await runFinishPass(args(), down.deps)).toMatchObject({ ok: false, reason: "sandbox" });

    const flaky = fakeSandbox();
    (flaky.deps.write as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("socket hang up"));
    expect(await runFinishPass(args(), flaky.deps)).toMatchObject({ ok: false, reason: "sandbox" });
    expect(flaky.destroyed).toEqual(["sbx_1"]);
  });
});
