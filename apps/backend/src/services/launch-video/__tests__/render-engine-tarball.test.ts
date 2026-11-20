import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveEngineTarball } from "../render";

const ORIG_ENV = process.env.LAUNCH_VIDEO_ENGINE_TGZ;

afterEach(() => {
  if (ORIG_ENV === undefined) delete process.env.LAUNCH_VIDEO_ENGINE_TGZ;
  else process.env.LAUNCH_VIDEO_ENGINE_TGZ = ORIG_ENV;
});

describe("resolveEngineTarball", () => {
  it("reads the explicit prebuilt tarball when LAUNCH_VIDEO_ENGINE_TGZ points at a real file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lv-prebuilt-"));
    const tgz = join(dir, "engine.tgz");
    const payload = Buffer.from("not-a-real-tgz-but-bytes");
    writeFileSync(tgz, payload);
    process.env.LAUNCH_VIDEO_ENGINE_TGZ = tgz;

    const out = resolveEngineTarball();
    expect(out.equals(payload)).toBe(true);
  });

  it("falls back to tarring the workspace source when no prebuilt tarball exists", () => {
    process.env.LAUNCH_VIDEO_ENGINE_TGZ = join(tmpdir(), "definitely-missing-engine.tgz");

    const out = resolveEngineTarball();
    expect(out.byteLength).toBeGreaterThan(0);
    expect(out[0]).toBe(0x1f);
    expect(out[1]).toBe(0x8b);
  });
});
