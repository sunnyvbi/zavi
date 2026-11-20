import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const progressSrc = readFileSync(
  join(__dirname, "../progress.ts"),
  "utf-8",
);

describe("progress.ts — Codex C14 whitelist regression guard", () => {
  it("still has the C14 contract comment at top of file", () => {
    expect(progressSrc).toMatch(/Codex C14 contract/);
    expect(progressSrc).toMatch(
      /meta only carries \{tool_name, ms, code, iter\}/,
    );
  });

  it("emitter is named makeEmitProgress and inserts to agent_run_events", () => {
    expect(progressSrc).toMatch(/export function makeEmitProgress/);
    expect(progressSrc).toMatch(/from\("agent_run_events"\)\.insert/);
  });

  it("only the 4 whitelisted meta keys are assigned (tool_name, ms, code, iter)", () => {
    expect(progressSrc).toMatch(/sanitizedMeta\.tool_name\s*=/);
    expect(progressSrc).toMatch(/sanitizedMeta\.ms\s*=/);
    expect(progressSrc).toMatch(/sanitizedMeta\.code\s*=/);
    expect(progressSrc).toMatch(/sanitizedMeta\.iter\s*=/);
  });

  it("FORBIDDEN fields are NEVER written to sanitizedMeta", () => {
    const forbidden = [
      "text",
      "output",
      "output_preview",
      "input",
      "prompt",
      "body",
      "content",
      "reasoning",
      "error_message",
      "target",
      "snippet",
      "raw",
    ];
    for (const key of forbidden) {
      const re = new RegExp(`sanitizedMeta\\.${key}\\s*=`);
      expect(
        progressSrc,
        `progress.ts MUST NOT assign sanitizedMeta.${key} — C14 regression`,
      ).not.toMatch(re);
    }
  });

  it("inserts ONLY {agent_run_id, tenant_id, stage, meta} columns to agent_run_events", () => {
    const insertBlock = progressSrc.match(
      /from\("agent_run_events"\)\.insert\(\{([\s\S]*?)\}\)/,
    );
    expect(insertBlock, "could not find agent_run_events.insert block")
      .not.toBeNull();
    const block = insertBlock![1];

    expect(block).toMatch(/agent_run_id/);
    expect(block).toMatch(/tenant_id/);
    expect(block).toMatch(/stage/);
    expect(block).toMatch(/meta/);

    const forbiddenCols = [
      "target",
      "output_preview",
      "error_message",
      "reasoning_text",
      "body",
      "citations",
    ];
    for (const col of forbiddenCols) {
      expect(
        block,
        `progress.ts must NOT insert agent_run_events.${col} — that column belongs on thread_event or doesn't exist`,
      ).not.toMatch(new RegExp(`\\b${col}\\b`));
    }
  });
});
