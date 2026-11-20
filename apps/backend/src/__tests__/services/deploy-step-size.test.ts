import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const WORKFLOWS = resolve(__dirname, "../../../../../.github/workflows");

const MAX_RUN_CHARS = 16_000;

function runBlocks(src: string): { line: number; body: string }[] {
  const lines = src.split("\n");
  const out: { line: number; body: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*run:\s*[|>][-+]?\s*$/.test(lines[i])) continue;
    const collected: string[] = [];
    let indent: number | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) {
        collected.push("");
        continue;
      }
      const ind = l.length - l.trimStart().length;
      if (indent === null) indent = ind;
      if (ind < indent) break;
      collected.push(l.slice(indent));
    }
    while (collected.length && !collected[collected.length - 1]) collected.pop();
    out.push({ line: i + 1, body: collected.join("\n") });
  }
  return out;
}

const workflowFiles = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

describe("workflow step-size cliff", () => {
  it("finds workflow files to check (guards against a silently empty scan)", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  it.each(workflowFiles)(
    "%s — no single step's run: script approaches the size GitHub rejects",
    (file) => {
      const src = readFileSync(resolve(WORKFLOWS, file), "utf8");
      const offenders = runBlocks(src)
        .filter((b) => b.body.length > MAX_RUN_CHARS)
        .map((b) => `${file}:${b.line} is ${b.body.length} chars`);

      expect(
        offenders,
        `A step's inline script exceeded ${MAX_RUN_CHARS} chars. Past ~21k GitHub ` +
          `rejects the ENTIRE workflow file with no error, no logs and no jobs — ` +
          `for deploy.yml that means prod deploys stop working silently. Move the ` +
          `prose into YAML-level comments above the step (they cost the step ` +
          `nothing), or extract the script to a checked-in file.\n` +
          offenders.join("\n"),
      ).toEqual([]);
    },
  );

  it("the generated on-box script still starts with its bash shebang", () => {
    const src = readFileSync(resolve(WORKFLOWS, "deploy.yml"), "utf8");
    const heredoc = /<<\s*'DEPLOY_SCRIPT_EOF'\n([\s\S]*?)\n\s*DEPLOY_SCRIPT_EOF/.exec(
      src,
    );
    expect(heredoc, "on-box deploy script heredoc not found").not.toBeNull();
    const firstLine = (heredoc as RegExpExecArray)[1]
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    expect(firstLine).toMatch(/^#!.*\bbash\b/);
  });

  it("actually measures the deploy script (proves the extractor is not returning empty)", () => {
    const src = readFileSync(resolve(WORKFLOWS, "deploy.yml"), "utf8");
    const biggest = Math.max(...runBlocks(src).map((b) => b.body.length));
    expect(biggest).toBeGreaterThan(5_000);
    expect(biggest).toBeLessThan(MAX_RUN_CHARS);
  });
});
