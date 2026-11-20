import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RUNNER = path.resolve(__dirname, "../runner.cjs");

describe("runner emitResult", () => {
  it("delivers a result line larger than a pipe buffer in full before exiting", () => {
    const script = `require(${JSON.stringify(RUNNER)}).emitResult({ ok: true, journeys: [], pad: "x".repeat(1200000) });`;
    const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, timeout: 20_000 });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    const line = r.stdout.trim();
    expect(JSON.parse(line).pad).toHaveLength(1200000);
  });

  it("exits 1 when the gate failed", () => {
    const script = `require(${JSON.stringify(RUNNER)}).emitResult({ ok: false, journeys: [] });`;
    const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf-8", timeout: 20_000 });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout.trim()).ok).toBe(false);
  });

  it("exits 2 instead of hanging when the reader never drains stdout", () => {
    const script =
      `const { spawn } = require("node:child_process");` +
      `const c = spawn(process.execPath, ["-e", ${JSON.stringify(`require(${JSON.stringify(RUNNER)}).emitResult({ ok: true, journeys: [], pad: "x".repeat(4000000) }, 500)`)}], { stdio: ["ignore", "pipe", "ignore"] });` +
      `c.on("exit", (code) => { process.stdout.write(String(code)); process.exit(0); });`;
    const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf-8", timeout: 20_000 });
    expect(r.error).toBeUndefined();
    expect(r.stdout).toBe("2");
  });
});
