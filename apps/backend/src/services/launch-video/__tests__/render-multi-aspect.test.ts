import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const calls = {
  createSandbox: 0,
  destroySandbox: 0,
  renderCmds: [] as string[],
  reads: [] as string[],
  writtenBriefs: [] as { path: string; aspect: string }[],
  writes: [] as string[],
};

vi.mock("@/services/sandbox/e2b-client", () => ({
  createSandbox: vi.fn(async () => {
    calls.createSandbox++;
    return "sbx-test";
  }),
  destroySandbox: vi.fn(async () => {
    calls.destroySandbox++;
  }),
  execCommand: vi.fn(async (_id: string, cmd: string) => {
    if (cmd.includes("render.mjs")) calls.renderCmds.push(cmd);
    return { exit_code: 0, stdout: "", stderr: "" };
  }),
  writeFile: vi.fn(async (_id: string, path: string, content: string) => {
    calls.writes.push(path);
    if (path.endsWith(".json")) {
      try {
        calls.writtenBriefs.push({ path, aspect: JSON.parse(content).aspect });
      } catch {
      }
    }
  }),
  readFileBytes: vi.fn(async (_id: string, path: string) => {
    calls.reads.push(path);
    return new TextEncoder().encode(`mp4:${path}`);
  }),
}));

const ORIG = process.env.LAUNCH_VIDEO_ENGINE_TGZ;
beforeEach(() => {
  calls.createSandbox = 0;
  calls.destroySandbox = 0;
  calls.renderCmds = [];
  calls.reads = [];
  calls.writtenBriefs = [];
  calls.writes = [];
  const dir = mkdtempSync(join(tmpdir(), "lv-multi-"));
  const tgz = join(dir, "engine.tgz");
  writeFileSync(tgz, Buffer.from("dummy-tgz-bytes"));
  process.env.LAUNCH_VIDEO_ENGINE_TGZ = tgz;
});
afterEach(() => {
  if (ORIG === undefined) delete process.env.LAUNCH_VIDEO_ENGINE_TGZ;
  else process.env.LAUNCH_VIDEO_ENGINE_TGZ = ORIG;
  vi.clearAllMocks();
});

import { renderLaunchVideoAspects } from "../render";
import { intakeToVideoBrief, type LaunchVideoIntake } from "../brief-mapper";

const intake: LaunchVideoIntake = {
  product_name: "Upcar",
  one_liner: "Rent the perfect car from local hosts.",
  url: "https://upcar.ai",
  audience: "weekend drivers",
  tone: "bold",
  features: [
    { title: "Book in two minutes", detail: "Reserve instantly." },
    { title: "Real local hosts", detail: "Cars from real people." },
  ],
  cta_text: "Start your trip",
  cta_url: "https://upcar.ai",
};

describe("renderLaunchVideoAspects — one sandbox, N renders", () => {
  it("renders 3 aspects in ONE sandbox (one npm install), one result + read per aspect", async () => {
    const brief = intakeToVideoBrief(intake);
    const { results } = await renderLaunchVideoAspects({
      tenant_id: "t1",
      brief,
      audio: new Map(),
      aspects: ["16:9", "1:1", "9:16"],
    });
    expect(calls.createSandbox).toBe(1);
    expect(calls.destroySandbox).toBe(1);
    expect(calls.renderCmds).toHaveLength(3);
    expect(calls.reads).toHaveLength(3);
    expect(results.map((r) => r.aspect)).toEqual(["16:9", "1:1", "9:16"]);
    for (const r of results) expect(r.bytes.byteLength).toBeGreaterThan(0);
    expect(calls.writtenBriefs.map((b) => b.aspect)).toEqual(["16:9", "1:1", "9:16"]);
  });

  it("injects generated media ONCE and reuses it across every aspect (budget independent of aspect count)", async () => {
    const brief = intakeToVideoBrief(intake);
    const images = [{ beatIndex: 0, itemIndex: null, filename: "img_hero.png", bytes: new TextEncoder().encode("png") }];
    const videos = [{ beatIndex: 1, filename: "vid_clip.mp4", bytes: new TextEncoder().encode("mp4") }];
    brief.beats.splice(1, 0, { kind: "broll", videoPrompt: "x", video: "vid_clip.mp4" } as never);
    await renderLaunchVideoAspects({ tenant_id: "t1", brief, audio: new Map(), images, videos, aspects: ["16:9", "1:1", "9:16"] });
    const heroWrites = calls.writes.filter((p) => p.includes("img_hero.png"));
    const clipWrites = calls.writes.filter((p) => p.includes("vid_clip.mp4"));
    expect(heroWrites.length).toBe(1);
    expect(clipWrites.length).toBe(1);
    expect(calls.createSandbox).toBe(1);
    expect(calls.renderCmds).toHaveLength(3);
  });

  it("dedups requested aspects and defaults an empty list to the brief's own aspect", async () => {
    const brief = intakeToVideoBrief({ ...intake, platform: "tiktok" });
    const { results } = await renderLaunchVideoAspects({
      tenant_id: "t1",
      brief,
      audio: new Map(),
      aspects: [],
    });
    expect(results.map((r) => r.aspect)).toEqual(["9:16"]);
    expect(calls.createSandbox).toBe(1);
    expect(calls.renderCmds).toHaveLength(1);
  });

  it("single-aspect renderLaunchVideo wrapper still returns {bytes,voicedBeats}", async () => {
    const { renderLaunchVideo } = await import("../render");
    const r = await renderLaunchVideo({ tenant_id: "t1", brief: intakeToVideoBrief(intake), audio: new Map() });
    expect(r.bytes.byteLength).toBeGreaterThan(0);
    expect(typeof r.voicedBeats).toBe("number");
    expect(calls.createSandbox).toBe(1);
  });
});
