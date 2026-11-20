import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf-8");
const STAMP_KEY = "stale_committed_dist";

describe("stale-committed-dist wiring", () => {
  it("post-run imports + calls the detector and stamps the key (fail-open)", () => {
    const postRun = read("../post-run.ts");
    const detections = read("../sandbox-detections.ts");
    expect(postRun).toMatch(/from "\.\/sandbox-detections"/);
    expect(postRun).toMatch(/runSandboxDetections\(/);
    expect(detections).toMatch(/from "\.\/stale-committed-dist"/);
    expect(detections).toMatch(/detectStaleCommittedDist\(/);
    expect(postRun).toContain(`).${STAMP_KEY} =`);
    expect(postRun).toMatch(/code:\s*"stale_committed_dist"/);
  });

  it("post-run stamps the key BEFORE the push_to_main stamp (so the hedge sees it)", () => {
    const postRun = read("../post-run.ts");
    const stampIdx = postRun.indexOf(`).${STAMP_KEY} =`);
    const pushIdx = postRun.indexOf("push_to_main = true");
    expect(stampIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(-1);
    expect(stampIdx).toBeLessThan(pushIdx);
  });

  it("the verifier evaluates the stamp BEFORE the passed early-return", () => {
    const v = read("../../../services/agents/engineer-unverified-claim-verifier.ts");
    const staleIdx = v.indexOf("args.stale_committed_dist");
    const passedIdx = v.indexOf('status === "passed"');
    expect(staleIdx).toBeGreaterThan(-1);
    expect(passedIdx).toBeGreaterThan(-1);
    expect(staleIdx).toBeLessThan(passedIdx);
  });

  it("both verifier seams thread the stamp", () => {
    const chat = read("../../../services/agents/chat-dispatcher.ts");
    const runner = read("../../../services/agents/runner.ts");
    expect(chat).toMatch(/stale_committed_dist:\s*parsedObj\?\.stale_committed_dist/);
    expect(runner).toMatch(/stale_committed_dist:\s*parsedObj\?\.stale_committed_dist/);
  });

  it("ship-gate surfaces a SOFT PR-body note for the stamp", () => {
    const shipGate = read("../ship-gate.ts");
    expect(shipGate).toContain(STAMP_KEY);
    expect(shipGate).toMatch(/Committed dist:/);
  });
});
