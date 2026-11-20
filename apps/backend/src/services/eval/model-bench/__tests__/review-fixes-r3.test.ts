import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendLedger } from "../spend";
import { resolveModel } from "../manifest";
import { loadFixtures, replaceTenantFixtures, type TaskFixture } from "../fixtures";
import { assertFixturesFilledFor, runBench } from "../bench";
import { codeFromSdkToolError } from "../modes";
import { renderScorecard } from "../scorecard";
import type { BenchModelClient, CompleteRequest } from "../client";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const qwen = resolveModel("qwen");
const kimi = resolveModel("kimi");

function fx(i: number, over: Partial<TaskFixture> = {}): TaskFixture {
  return {
    fixture_version: 1,
    task_id: `upcar-ai.pm.task${i}`,
    tenant_id: T,
    company: "upcar-ai",
    agent_slug: "pm",
    unit: "pm",
    cohort: "role",
    source_run_id: `s${i}`,
    input: { trigger: "cron", payload: null, prompt: { system: "s", initial_user: "u" } },
    evidence: [{ tenant_id: T, tool_name: "memory__search", input: { q: "x" }, content: "c", is_error: false }],
    filled_by: ["qwen", "claude-shared", "claude-sdk"],
    expected: {
      drafted_by: "gpt-5.5",
      drafter_family: "openai",
      assertions: [{ id: "a1", text: "t", cites: 0, expect_number: 12 }],
      uncited_ids: [],
    },
    ...over,
  };
}

describe("r3 item 1 — a stale fixture not filled by this build's models is dropped", () => {
  it("add-a-new-model build with a seedless unit: the run is not blocked and the unit is not covered", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-r3-"));
    const seo = fx(5, { task_id: "upcar-ai.seo.task5", unit: "seo", cohort: "channel" });
    replaceTenantFixtures(T, [fx(1), seo], dir, ["qwen", "claude-shared", "claude-sdk"]);
    const pm2 = fx(2, { filled_by: ["kimi", "claude-shared", "claude-sdk"] });
    const out = replaceTenantFixtures(T, [pm2], dir, ["kimi", "claude-shared", "claude-sdk"]);
    expect(out.droppedStale.map((f) => f.task_id)).toEqual(["upcar-ai.seo.task5"]);
    expect(out.keptStale).toEqual([]);
    const fixtures = loadFixtures(dir);
    expect(() => assertFixturesFilledFor(fixtures, kimi)).not.toThrow();
    const md = renderScorecard({
      date: "d", model_key: "kimi", model_lineage: "x", harness_sha: "s", trials: 1, fixtures,
      candidate: [], reference_sdk: [], harness_shared: [],
      judges: "judge_unavailable", harness_judges: "judge_unavailable", spent_usd: 0, max_usd: 1, partial: false, dry_run: false,
    });
    expect(md).toContain("| seo | - | - | - | not covered: no usable run |");
  });

  it("a stale fixture already filled by every model of this build is kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-r3k-"));
    const seo = fx(5, { task_id: "upcar-ai.seo.task5", unit: "seo", cohort: "channel" });
    replaceTenantFixtures(T, [fx(1), seo], dir);
    const out = replaceTenantFixtures(T, [fx(2)], dir, ["qwen", "claude-shared", "claude-sdk"]);
    expect(out.keptStale.map((f) => f.task_id)).toEqual(["upcar-ai.seo.task5"]);
  });
});

describe("r3 item 2 — harness partiality comes from the harness inputs, not the global ledger flag", () => {
  it("a harness judge settling above its reservation with all pairs complete still renders the gap", async () => {
    let calls = 0;
    const client: BenchModelClient = {
      async complete(_req: CompleteRequest) {
        calls++;
        return { text: '{"better":"tie","reason":"r"}', billedUsd: calls === 4 ? 0.9 : 0.001 };
      },
    };
    const ledger = new SpendLedger(100);
    const report = await runBench({
      fixtures: [fx(1)], candidate: qwen, trials: 1, concurrency: 1, sandboxConcurrency: 1, ledger,
      runTrialFor: () => async () => ({ value: { output_text: "12", parse_ok: true, tool_calls: [], route_verdict: "ok" }, billedUsd: 0.01 }),
      beforeModel: () => {}, client, cache: { get: () => null, put: () => {} },
      date: "d", harness_sha: "sha", dry_run: true, sleep: async () => {},
    });
    expect(ledger.stopReason).toBe("reservation_exceeded");
    expect(report.partial).toBe(true);
    const line = report.markdown.split("\n").find((l) => l.startsWith("| Harness effect"))!;
    expect(line).not.toContain("n/a");
    expect(line).toMatch(/\| \+0\.00 \|/);
  });
});

describe("r3 item 3 — a JSON-encoded string preview is parsed once more", () => {
  it("a string-valued {\"error\":\"tool_input_invalid\"} counts", () => {
    const preview = JSON.stringify(JSON.stringify({ error: "tool_input_invalid" }));
    expect(codeFromSdkToolError(preview)).toBe("tool_input_invalid");
  });
});
