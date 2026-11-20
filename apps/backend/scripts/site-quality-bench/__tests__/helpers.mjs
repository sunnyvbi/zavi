import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlaywright } from "../lib/collect.mjs";

export const PLAYWRIGHT_MODULE = process.env.BENCH_PLAYWRIGHT_MODULE || "playwright-core";

export async function browserAvailable(spec = PLAYWRIGHT_MODULE) {
  try {
    const pw = await loadPlaywright(spec);
    const exe = pw.chromium.executablePath();
    return typeof exe === "string" && exe !== "" && existsSync(exe);
  } catch {
    return false;
  }
}

export const HAS_BROWSER = await browserAvailable();

export function tmp(prefix = "sqb-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function baseRecord(over = {}) {
  return {
    run_id: "run-1",
    brief_id: "dental-clinic",
    system: "zavi",
    provenance: "actual_ai_build",
    captured_at: "2026-10-07T10:00:00.000Z",
    urls: { site: "https://example.test" },
    screenshots: { desktop: "shots/run-1-desktop.png", mobile: "shots/run-1-mobile.png" },
    timings: { to_first_preview_s: 30, to_usable_complete_s: 400 },
    cost: { usd: 2.5, source: "agent_runs.cost_usd sum over 4 attempts" },
    repairs: 0,
    failures: [],
    journeys: [{ name: "book_appointment", passed: true }],
    requirement_coverage: [{ requirement: "name", met: true, evidence: "auto-text" }],
    scores: null,
    ...over,
  };
}

export function allFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) allFiles(p, out);
    else out.push(p);
  }
  return out;
}

export function grepDir(dir, needle) {
  const n = Buffer.from(needle.toLowerCase());
  return allFiles(dir).filter((f) => readFileSync(f).toString("latin1").toLowerCase().includes(n.toString("latin1")));
}

export function captureOut() {
  const chunks = [];
  return { out: (s) => chunks.push(s), text: () => chunks.join("") };
}
