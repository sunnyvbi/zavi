import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("P0 — cto early-gate surfaces the model's prose (post-run.ts)", () => {
  const src = readFileSync(join(__dirname, "../post-run.ts"), "utf-8");

  it("extracts envelope.rendered_markdown in the early refused/prose gate", () => {
    expect(src).toMatch(/rendered_markdown\?\:\s*unknown/);
    expect(src).toMatch(/\.rendered_markdown\.trim\(\)/);
  });

  it("falls back to the curt shipBlockExplanation only when there is no prose", () => {
    expect(src).toMatch(
      /rm\.length\s*>\s*0\s*\?\s*rm\s*:\s*shipBlockExplanation\(earlyGate\.reason\)/,
    );
  });

  it("early gate is still scoped to refused_envelope / prose_fallback only", () => {
    expect(src).toMatch(
      /earlyGate\.reason === "refused_envelope" \|\|[\s\S]*?earlyGate\.reason === "prose_fallback"/,
    );
  });

  it("empty_diff branch still surfaces rendered_markdown (unchanged precedent)", () => {
    expect(src).toMatch(/reason:\s*"empty_diff"/);
  });

  it("empty_diff carries the server typecheck + test verdicts as side_effect detail", () => {
    expect(src).toMatch(
      /reason:\s*"empty_diff",[\s\S]{0,500}`typecheck:\$\{typecheckFromTraces\(toolCalls \?\? \[\]\)\.status\};`[\s\S]{0,80}`tests:\$\{verifyFromTraces\(toolCalls \?\? \[\]\)\.status\}`/,
    );
  });

  it("size-cap rejections become a graceful over_ship_cap suppress that surfaces the diagnosis", () => {
    expect(src).toMatch(/reason:\s*"over_ship_cap"/);
    expect(src).toMatch(/d\.kind === "max_changed_lines_exceeded"/);
    expect(src).toMatch(/d\.kind === "diff_byte_cap_exceeded"/);
    expect(src).toMatch(/d\.kind === "max_post_image_bytes_exceeded"/);
    expect(src).toMatch(/rm\.length\s*>\s*0\s*\?\s*rm\s*\+\s*notice/);
  });

  it("hard rejections (forbidden_path / git errors) still fail curtly via builder_rejected", () => {
    expect(src).toMatch(/reason:\s*`builder_rejected:\$\{d\.kind\}`/);
  });
});

describe("P1 — non-chat suppress persists as success, not parse_failed (side-effect-dispatcher.ts)", () => {
  const src = readFileSync(
    join(__dirname, "../../lib/side-effect-dispatcher.ts"),
    "utf-8",
  );

  it("delegates the answered/parse_ok decision to suppress-policy (single source of truth)", () => {
    expect(src).toMatch(
      /import \{ suppressAnsweredNoAction \} from "@\/agents\/lib\/suppress-policy"/,
    );
    expect(src).toMatch(
      /result\.parse_ok\s*=\s*suppressAnsweredNoAction\(\s*transformed\.reason,\s*transformed\.output_text,?\s*\)/,
    );
  });

  it("still nulls parsed on suppress so the emit path stays blocked (REAL money-path guard)", () => {
    expect(src).toMatch(/if \("suppress" in transformed\)[\s\S]*?result\.parsed = null/);
    expect(src).toMatch(/!result\.parse_ok\s*\|\|\s*result\.parsed\s*==\s*null/);
  });
});

describe("P1 — suppress→answered policy (suppress-policy.ts)", () => {
  const src = readFileSync(
    join(__dirname, "../../lib/suppress-policy.ts"),
    "utf-8",
  );

  it("treats refused/prose/over_ship_cap AND held PRs (critic_fail/task_mismatch) as answered", () => {
    for (const reason of [
      "refused_envelope",
      "prose_fallback",
      "over_ship_cap",
      "critic_fail",
      "task_mismatch",
    ]) {
      expect(src).toContain(`"${reason}"`);
    }
  });

  it("requires a non-empty output_text before promoting to answered", () => {
    expect(src).toMatch(/output_text\.trim\(\)\.length\s*>\s*0/);
  });
});

describe("P1-2 — repo/sandbox failure surfaces a message, no silent drop", () => {
  const postRun = readFileSync(join(__dirname, "../post-run.ts"), "utf-8");
  const index = readFileSync(join(__dirname, "../../index.ts"), "utf-8");

  it("post-run suppresses (not throws) when repo_hint is missing", () => {
    expect(postRun).toMatch(/reason:\s*"no_repo"/);
    expect(postRun).not.toMatch(
      /throw new Error\(\s*"engineer post-run: payload\.repo_hint missing/,
    );
  });

  it("post-run suppresses (not throws) when no active sandbox", () => {
    expect(postRun).toMatch(/reason:\s*"no_sandbox"/);
    expect(postRun).not.toMatch(
      /throw new Error\(\s*`engineer post-run: no active sandbox/,
    );
  });

  it("index.ts reason-GATES the parsed clear to no_repo/no_sandbox only", () => {
    expect(index).toMatch(
      /outcome\.reason === "no_repo" \|\| outcome\.reason === "no_sandbox"/,
    );
    expect(index).toMatch(
      /outcome\.reason === "no_repo"[\s\S]{0,80}result\.parsed = null/,
    );
  });
});

describe("P1-3 — red ship-gate warns in the chat confirm bubble", () => {
  const postRun = readFileSync(join(__dirname, "../post-run.ts"), "utf-8");
  const index = readFileSync(join(__dirname, "../../index.ts"), "utf-8");

  it("post-run stamps ship_gate_warning on the warn-and-ship branch", () => {
    expect(postRun).toMatch(/ship_gate_warning\s*=\s*fullGate\.reason/);
  });

  it("index.ts surfaces a RED verification warning WIRED to ship_gate_warning", () => {
    expect(index).toMatch(/ship_gate_warning/);
    expect(index).toMatch(
      /shipGateWarning\s*\n?\s*\?[\s\S]{0,120}came back red/,
    );
  });
});
