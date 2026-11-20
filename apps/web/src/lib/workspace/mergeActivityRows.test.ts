import { describe, it, expect } from "vitest";
import { mergeActivityRows } from "./mergeActivityRows";
import type { ThreadEventRow } from "./useChatThread";

const te = (
  id: number,
  agent_run_id: string | null,
  kind: string,
  created_at: string,
  body: Record<string, unknown> = {},
): ThreadEventRow => ({ id, agent_run_id, kind, body, citations: [], created_at });

const CTO = "engineer";

describe("mergeActivityRows", () => {
  it("returns rows for NON-cto agents (live feed ungated for the whole fleet)", () => {
    const rows = [
      te(1, "r1", "reasoning", "2026-01-01T00:00:01Z", { text: "inspecting campaigns" }),
      te(2, "r1", "tool_call", "2026-01-01T00:00:02Z", {
        tool_name: "meta_ads__list_ad_sets",
        target: '{"campaign_id":"123"}',
      }),
    ];
    const adsOut = mergeActivityRows("performance-marketer", rows, "r1", new Set());
    expect(adsOut.map((r) => r.id)).toEqual(["te:1", "te:2"]);
    expect(adsOut[1]).toMatchObject({
      kind: "chat_activity",
      agent_run_id: "r1",
      body: {
        teKind: "tool_call",
        tool_name: "meta_ads__list_ad_sets",
        target: '{"campaign_id":"123"}',
      },
    });
    expect(mergeActivityRows("pm", rows, "r1", new Set())).toHaveLength(2);
  });

  it("copies only the named fields, per kind", () => {
    const rows = [
      te(1, "r1", "tool_call", "2026-01-01T00:00:01Z", {
        tool_name: "operator_db__query",
        target: '{"collection":"trips"}',
        output_preview: "1204 rows",
        error_message: "",
        code: "ok",
        ms: 1234,
        iter: 2,
      }),
      te(2, "r1", "reasoning", "2026-01-01T00:00:02Z", {
        text: "agent reasoning prose",
        raw_input: "the operator's private prompt",
      }),
    ];
    const out = mergeActivityRows("performance-marketer", rows, "r1", new Set());
    const toolBody = out[0].body as Record<string, unknown>;
    expect(toolBody).toEqual({
      teKind: "tool_call",
      tool_name: "operator_db__query",
      target: '{"collection":"trips"}',
      output_preview: "1204 rows",
      error_message: "",
      code: "ok",
      ms: 1234,
    });
    expect(toolBody).not.toHaveProperty("iter");

    const reasoningBody = out[1].body as Record<string, unknown>;
    expect(reasoningBody).toEqual({ teKind: "reasoning", text: "agent reasoning prose" });
    expect(reasoningBody).not.toHaveProperty("raw_input");
  });

  it("returns [] when there is no active run", () => {
    const rows = [te(1, "r1", "reasoning", "2026-01-01T00:00:00Z")];
    expect(mergeActivityRows(CTO, rows, null, new Set())).toEqual([]);
    expect(mergeActivityRows("performance-marketer", rows, null, new Set())).toEqual([]);
  });

  it("emits chat_activity only for the active run's timeline kinds", () => {
    const rows = [
      te(1, "r1", "reasoning", "2026-01-01T00:00:01Z", { text: "thinking" }),
      te(2, "r1", "tool_call", "2026-01-01T00:00:02Z", { tool_name: "view", target: "f.ts" }),
      te(3, "r1", "chat_assistant", "2026-01-01T00:00:03Z", { text: "done" }),
      te(4, "r2", "reasoning", "2026-01-01T00:00:04Z", { text: "other run" }),
    ];
    const out = mergeActivityRows(CTO, rows, "r1", new Set());
    expect(out.map((r) => r.id)).toEqual(["te:1", "te:2"]);
    expect(out[0]).toMatchObject({
      kind: "chat_activity",
      agent_run_id: "r1",
      body: { teKind: "reasoning", text: "thinking" },
    });
  });

  it("keeps the cto plan block (summary + steps) whitelisted", () => {
    const rows = [
      te(1, "r1", "plan", "2026-01-01T00:00:01Z", {
        summary: "ship the fix",
        steps: ["read repo", "edit file", 42, "open PR"],
        leaked: "should not survive",
      }),
    ];
    const out = mergeActivityRows(CTO, rows, "r1", new Set());
    expect(out[0].body).toEqual({
      teKind: "plan",
      summary: "ship the fix",
      steps: ["read repo", "edit file", "open PR"],
    });
  });

  it("drops activity rows once the run has a finished assistant bubble", () => {
    const rows = [te(1, "r1", "plan", "2026-01-01T00:00:01Z", { summary: "x" })];
    expect(mergeActivityRows(CTO, rows, "r1", new Set(["r1"]))).toEqual([]);
    expect(mergeActivityRows("performance-marketer", rows, "r1", new Set(["r1"]))).toEqual([]);
  });

  it("ignores non-timeline kinds (decision/run_start/run_end)", () => {
    const rows = [
      te(1, "r1", "decision", "2026-01-01T00:00:01Z"),
      te(2, "r1", "run_start", "2026-01-01T00:00:02Z"),
      te(3, "r1", "run_end", "2026-01-01T00:00:03Z"),
    ];
    expect(mergeActivityRows("performance-marketer", rows, "r1", new Set())).toEqual([]);
  });

  it("keeps handoff calls for the panel to word", () => {
    const rows = [
      te(1, "r1", "tool_call", "2026-01-01T00:00:01Z", {
        tool_name: "praxis__handoff",
        target: '{"target_agent_slug":"engineer"}',
      }),
      te(3, "r1", "tool_call", "2026-01-01T00:00:03Z", {
        tool_name: "web_search__search",
        target: '{"query":"cloth store"}',
      }),
    ];
    const out = mergeActivityRows("operator", rows, "r1", new Set());
    expect(out.map((r) => r.id)).toEqual(["te:1", "te:3"]);
  });

  it("keeps customer-meaningful praxis__ tools", () => {
    const rows = [
      te(1, "r1", "tool_call", "2026-01-01T00:00:01Z", {
        tool_name: "praxis__slack__post_message",
        target: '{"channel":"#general"}',
      }),
      te(2, "r1", "tool_call", "2026-01-01T00:00:02Z", {
        tool_name: "praxis__remind",
        target: '{"text":"renew the listing"}',
      }),
    ];
    const out = mergeActivityRows("operator", rows, "r1", new Set());
    expect(out.map((r) => r.id)).toEqual(["te:1", "te:2"]);
  });

  it("teKind cannot be overridden by event body (whitelist sets it last)", () => {
    const rows = [te(1, "r1", "reasoning", "2026-01-01T00:00:01Z", { teKind: "evil", text: "t" })];
    const out = mergeActivityRows(CTO, rows, "r1", new Set());
    expect((out[0].body as Record<string, unknown>).teKind).toBe("reasoning");
  });
});

import { detailedActivityByRun } from "./mergeActivityRows";
describe("mergeActivityRows — the tool result", () => {
  const te = (id: string, run: string, body: Record<string, unknown>) =>
    ({ id, kind: "tool_call", agent_run_id: run, agent_slug: "operator", body, citations: [], created_at: "2026-09-07T00:00:00Z" }) as never;
  it("carries output_preview/code/ms, and still nothing else", () => {
    const rows = [te("1", "r1", { tool_name: "web_search__search", target: "{}", output_preview: "3 hits", code: "ok", ms: 12, error_message: "", iter: 4, raw_input: "secret" })];
    const body = mergeActivityRows("operator", rows, "r1", new Set())[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ tool_name: "web_search__search", output_preview: "3 hits", code: "ok", ms: 12, teKind: "tool_call" });
    expect(body).not.toHaveProperty("iter");
    expect(body).not.toHaveProperty("raw_input");
  });
  it("detailedActivityByRun groups finished runs by run id", () => {
    const rows = [
      te("1", "r1", { tool_name: "web_search__search", target: "{}", output_preview: "x" }),
      te("2", "r1", { tool_name: "praxis__handoff", target: "{}", output_preview: "y" }),
      te("3", "r2", { tool_name: "memory__search", target: "{}", output_preview: "z" }),
      te("4", "r9", { tool_name: "memory__search", target: "{}", output_preview: "w" }),
    ];
    const m = detailedActivityByRun(rows, new Set(["r1", "r2"]));
    expect([...m.keys()]).toEqual(["r1", "r2"]);
    expect(m.get("r1")!.map((r) => (r.body as { tool_name: string }).tool_name)).toEqual(["web_search__search", "praxis__handoff"]);
    expect((m.get("r2")![0].body as { output_preview: string }).output_preview).toBe("z");
  });
});
