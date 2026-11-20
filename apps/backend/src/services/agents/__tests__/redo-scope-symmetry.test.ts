
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REDO_ALLOWED_DECISION_CLASS,
  redoRefusesClass,
  stripProposeToolsOnRedo,
} from "@/services/agents/redo-mode";

const TOOLS_ROOT = join(__dirname, "../../tools");

const SERVER_FOR_DIR: Record<string, string> = {
  "google-ads": "google_ads",
  "meta-ads": "meta_ads",
  social: "social",
  "generated-video": "generated_video",
  growth: "growth",
  "reddit-ads": "reddit_ads",
  "x-ads": "x_ads",
  "chatgpt-ads": "chatgpt_ads",
  "linkedin-ads": "linkedin_ads",
  "tiktok-ads": "tiktok_ads",
  "email-campaign": "email_campaign",
  email: "email",
  seo: "seo",
  geo: "geo",
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(full);
    return e.name.endsWith(".ts") ? [full] : [];
  });
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/([^:])\/\/.*$/gm, "$1");
}

function reachesEmitter(src: string): boolean {
  const code = stripComments(src);
  return /\bemit_decision\b/.test(code) || /\bawait emit\(/.test(code);
}

function resolvedName(specName: string, filePath: string): string {
  if (specName.includes("__")) return specName;
  const dir = filePath.split(/[\\/]/).find((seg) => seg in SERVER_FOR_DIR);
  if (!dir) throw new Error(`no server mapping for ${filePath}`);
  const server = SERVER_FOR_DIR[dir];
  return `${server}__${specName.replace(new RegExp(`^${server}_`), "")}`;
}

type ProposeTool = { resolved: string; emits: boolean; file: string };

const PROPOSE_TOOLS: ProposeTool[] = walk(TOOLS_ROOT)
  .flatMap((file) => {
    const src = readFileSync(file, "utf8");
    const m = src.match(/name:\s*"([a-z_0-9]*propose[a-z_0-9]*)"/);
    if (!m) return [];
    return [{ resolved: resolvedName(m[1], file), emits: reachesEmitter(src), file }];
  })
  .sort((a, b) => a.resolved.localeCompare(b.resolved));

describe("the propose-tool census this test reasons over", () => {
  it("found tools on both sides, so the assertions below are not vacuous", () => {
    expect(PROPOSE_TOOLS.length).toBeGreaterThanOrEqual(20);
    expect(PROPOSE_TOOLS.some((t) => t.emits)).toBe(true);
    expect(PROPOSE_TOOLS.some((t) => !t.emits)).toBe(true);
  });

  it("classifies the indirect Google emitters as emitting", () => {
    const removal = PROPOSE_TOOLS.find((t) => t.resolved === "google_ads__propose_removal");
    expect(removal, "google_ads__propose_removal not found").toBeTruthy();
    expect(removal!.emits).toBe(true);
  });

  it("classifies the brief writer as NOT emitting", () => {
    const brief = PROPOSE_TOOLS.find((t) => t.resolved === "growth__propose_creative_brief");
    expect(brief, "growth__propose_creative_brief not found").toBeTruthy();
    expect(brief!.emits).toBe(false);
  });
});

describe("layer 1 strips exactly what layer 2 refuses", () => {
  const all = PROPOSE_TOOLS.map((t) => ({ name: t.resolved }));
  const survivors = new Set(stripProposeToolsOnRedo(all, true).map((t) => t.name));

  it("every emit-bearing propose tool is stripped", () => {
    const leaked = PROPOSE_TOOLS.filter((t) => t.emits && survivors.has(t.resolved));
    expect(
      leaked.map((t) => `${t.resolved} (${t.file})`),
      "these reach emit_decision but survive the strip, so the belt is the only thing catching them",
    ).toEqual([]);
  });

  it("no tool that cannot emit is stripped", () => {
    const overreach = PROPOSE_TOOLS.filter((t) => !t.emits && !survivors.has(t.resolved));
    expect(
      overreach.map((t) => `${t.resolved} (${t.file})`),
      "these never reach emit_decision, so layer 2 cannot refuse them and layer 1 must not strip them",
    ).toEqual([]);
  });

  it("and layer 2 really would refuse everything layer 1 strips", () => {
    for (const t of PROPOSE_TOOLS.filter((x) => !survivors.has(x.resolved))) {
      expect(t.emits, `${t.resolved} was stripped but does not emit`).toBe(true);
    }
    expect(redoRefusesClass(true, REDO_ALLOWED_DECISION_CLASS)).toBe(false);
  });
});
