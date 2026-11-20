
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../index.ts"), "utf-8");

const start = SRC.indexOf("STAGED BUT NEVER SHOWN");
const BLOCK = start === -1 ? "" : SRC.slice(start, start + 2200);

describe("a staged-but-unemitted preview suppresses the build", () => {
  it("has the guard", () => {
    expect(start).toBeGreaterThan(-1);
  });

  it("fires only when NO preview block was emitted and no surface resolved", () => {
    expect(BLOCK).toMatch(/!surface\s*&&\s*!hasHtmlPreviewBlock\(rawText\)/);
  });

  it("reads the artifact row for THIS run, and only acts on a ready one", () => {
    expect(BLOCK).toContain("loadRunHtmlPreviewState");
    expect(BLOCK).toMatch(/run_id:\s*ctx\.runId/);
    expect(BLOCK).toMatch(/status === "html_preview_ready"/);
  });

  it("persists a typed failure and RETURNS, so runCtoPostRun never opens a PR", () => {
    expect(BLOCK).toMatch(/persistPreviewFailure\("artifact_missing"\)/);
    expect(BLOCK).toMatch(/persistPreviewFailure[\s\S]{0,400}?\n\s*return;/);
  });

  it("runs BEFORE the `if (surface)` staging branch", () => {
    const surfaceBranch = SRC.indexOf("if (surface) {", start);
    expect(surfaceBranch).toBeGreaterThan(start);
  });
});

describe("loadRunHtmlPreviewState soft-fails", () => {
  const SVC = readFileSync(
    join(__dirname, "../../../services/agents/html-preview-artifacts.ts"),
    "utf-8",
  );
  it("returns null on a read error instead of throwing into the ship path", () => {
    const fn = SVC.slice(SVC.indexOf("export async function loadRunHtmlPreviewState"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/catch\s*\{\s*return null;\s*\}/);
  });
});
