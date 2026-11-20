import { describe, it, expect } from "vitest";
import { buildRunProofDTO } from "../run-trace";

describe("buildRunProofDTO — C14 allowlist + redaction", () => {
  const hostile = {
    run: {
      id: "run-1",
      agent_slug: "performance-marketer",
      status: "success",
      started_at: "2026-07-04T00:00:00Z",
      finished_at: "2026-07-04T00:01:00Z",
    },
    tool_calls: [
      {
        name: "slack__post_message",
        input_preview: '{"channel":"#growth","token":"xoxb-SECRET-TOKEN"}',
        output_preview: '{"ok":true,"ts":"1719","raw":"jane@example.com"}',
        target: '{"url":"https://x?token=ghp_LEAK"}',
        ms: 42,
        status: "ok",
        code: undefined,
        error_message: "should never appear",
      },
      {
        name: "meta_ads__update_budget",
        input_preview: "secret",
        output_preview: "boom",
        target: "t",
        ms: 10,
        status: "tool_error",
        code: "rate_limited",
        error_message: "429 from graph api",
      },
    ],
    output_text: "Bumped the budget and emailed the host at jane@example.com.",
    thread_events: [
      { kind: "plan", body: { summary: "Contact host jane@example.com", steps: ["call +1 415 555 0199", "post recap"] } },
      { kind: "reasoning", body: { text: "SSN on file is 123-45-6789, proceeding." } },
      { kind: "tool_call", body: { output_preview: "LEAK-VIA-THREAD-EVENT" } },
    ],
    decisions: [
      {
        decision_class: "bulk_outbound_send",
        status: "approved",
        body: { title: "Email 40 hosts at ops@example.com", subject: "blast" },
        dispatched_at: "2026-07-04T00:02:00Z",
      },
    ],
  };

  const dto = buildRunProofDTO(hostile);
  const json = JSON.stringify(dto);

  it("never leaks raw tool-I/O field names (C14)", () => {
    for (const banned of ["input_preview", "output_preview", "error_message", "target"]) {
      expect(json).not.toContain(banned);
    }
  });

  it("never leaks raw tool output / secret / injected thread_event content", () => {
    expect(json).not.toContain("xoxb-SECRET-TOKEN");
    expect(json).not.toContain("ghp_LEAK");
    expect(json).not.toContain("LEAK-VIA-THREAD-EVENT");
    expect(json).not.toContain("429 from graph api");
  });

  it("redacts PII in plan / reasoning / decision / final prose", () => {
    expect(json).not.toContain("jane@example.com");
    expect(json).not.toContain("ops@example.com");
    expect(json).not.toContain("123-45-6789");
    expect(json).not.toContain("415 555 0199");
    expect(json).toContain("‹redacted:email›");
    expect(json).toContain("‹redacted:ssn›");
  });

  it("renders actions from tool_calls with mapped status + empty receipts (pre-S4)", () => {
    expect(dto.actions).toHaveLength(2);
    expect(dto.actions[0]).toMatchObject({ name: "slack__post_message", status: "ok", ms: 42, receipts: [] });
    expect(dto.actions[1]).toMatchObject({ name: "meta_ads__update_budget", status: "error" });
  });

  it("surfaces approval-path decisions with class + status + dispatched_at", () => {
    expect(dto.decisions).toHaveLength(1);
    expect(dto.decisions[0]).toMatchObject({
      decision_class: "bulk_outbound_send",
      status: "approved",
      dispatched_at: "2026-07-04T00:02:00Z",
    });
  });

  it("carries plan + reasoning timeline, ignoring tool_call thread_events", () => {
    expect(dto.plan?.steps).toHaveLength(2);
    expect(dto.timeline).toHaveLength(1);
    expect(dto.timeline[0].kind).toBe("reasoning");
  });
});

describe("buildRunProofDTO — machine-envelope reasoning filter", () => {
  function dtoFor(reasoningText: string) {
    return buildRunProofDTO({
      run: { id: "r", agent_slug: "pm", status: "success", started_at: null, finished_at: null },
      tool_calls: [],
      output_text: null,
      thread_events: [{ kind: "reasoning", body: { text: reasoningText } }],
      decisions: [],
    });
  }

  it("drops an XML-ish machine envelope (internal-structure exposure)", () => {
    const d = dtoFor(
      '<product_pm_backlog>{"snapshot_run_id":"abc","target":"product","agent_run_id":"xyz"}</product_pm_backlog>',
    );
    expect(d.timeline).toHaveLength(0);
    expect(JSON.stringify(d)).not.toContain("snapshot_run_id");
    expect(JSON.stringify(d)).not.toContain("agent_run_id");
  });

  it("drops a bare JSON blob emitted as reasoning", () => {
    const d = dtoFor('{"status":"no_signal","artifact_label":"marketplace"}');
    expect(d.timeline).toHaveLength(0);
  });

  it("keeps genuine human-prose reasoning (even if it starts with a brace-ish char)", () => {
    const d = dtoFor("Bumped the Summer-CA budget because CPA was under target.");
    expect(d.timeline).toHaveLength(1);
    expect(d.timeline[0].text).toContain("Summer-CA");
  });

  it("keeps prose that starts with '{' but is not valid JSON", () => {
    const d = dtoFor("{the plan} was to reach out to hosts first, then guests.");
    expect(d.timeline).toHaveLength(1);
  });
});
