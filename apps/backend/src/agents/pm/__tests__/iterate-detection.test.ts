import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("P0a — follow-up detection broadened + self-exclusion guard", () => {
  const cd = readFileSync(
    join(__dirname, "../../../services/agents/chat-dispatcher.ts"),
    "utf-8",
  );

  it("excludes the CURRENT run so turn-1 doesn't self-match (first-turn guard)", () => {
    expect(cd).toMatch(/\.neq\("id",\s*ctx\.runId\)/);
  });

  it("no longer gates follow-up detection on actionable status / parse_ok", () => {
    const i = cd.indexOf('.neq("id", ctx.runId)');
    expect(i).toBeGreaterThan(-1);
    const probe = cd.slice(i - 400, i + 200);
    expect(probe).not.toMatch(/parsed->>status/);
    expect(probe).not.toMatch(/\.eq\("parse_ok",\s*true\)/);
  });

  it("fails SAFE to iterate (not delivery) on a lookup error", () => {
    const i = cd.indexOf("if (pmErr)");
    expect(i).toBeGreaterThan(-1);
    const arm = cd.slice(i, i + 800);
    expect(arm).toMatch(/hasPriorArtifact = true/);
    expect(arm).toMatch(/failing safe to iterate/i);
  });

  it("logs mode-resolution telemetry as metadata only (no raw user text)", () => {
    expect(cd).toMatch(/\[pm mode\]/);
    const i = cd.indexOf("[pm mode]");
    const line = cd.slice(i, i + 200);
    expect(line).not.toMatch(/current_message|userText|llm_input_message/);
  });
});

describe("P0b — held (cap_exceeded) items surface as Recommended", () => {
  const pr = readFileSync(join(__dirname, "../post-run.ts"), "utf-8");

  it("moves cap_exceeded skips into recommended_actions_not_dispatched", () => {
    expect(pr).toMatch(/RECOMMENDABLE_SKIP_REASONS/);
    expect(pr).toMatch(/"forbidden_target",\s*"cap_exceeded"/);
  });

  it("updates the dedup set after a push (no double-recommend)", () => {
    expect(pr).toMatch(/alreadyRecommended\.add\(s\.item_id\)/);
  });
});
