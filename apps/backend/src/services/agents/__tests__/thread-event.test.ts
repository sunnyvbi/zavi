import { describe, it, expect } from "vitest";
import { buildCitationsFromContext } from "../thread-event";
import { runEndTrigger } from "../thread-event-types";
import {
  BODY_SCHEMAS,
  CitationSchema,
  THREAD_EVENT_KINDS,
} from "../thread-event-types";

describe("buildCitationsFromContext", () => {
  it("returns empty array on empty input", () => {
    expect(buildCitationsFromContext({})).toEqual([]);
    expect(
      buildCitationsFromContext({ memoryHits: [], runRefs: [] }),
    ).toEqual([]);
  });

  it("builds memory_doc citations with explicit label", () => {
    const out = buildCitationsFromContext({
      memoryHits: [
        { slug: "trust-safety", label: "Trust & Safety policy" },
      ],
    });
    expect(out).toEqual([
      {
        kind: "memory_doc",
        ref: "trust-safety",
        label: "Trust & Safety policy",
      },
    ]);
  });

  it("falls back to slug as label when none provided", () => {
    const out = buildCitationsFromContext({
      memoryHits: [{ slug: "disputes" }],
    });
    expect(out[0]).toEqual({
      kind: "memory_doc",
      ref: "disputes",
      label: "disputes",
    });
  });

  it("builds agent_run citations with short-hash label fallback", () => {
    const out = buildCitationsFromContext({
      runRefs: [{ run_id: "abcd1234-1111-2222-3333-444455556666" }],
    });
    expect(out[0]).toEqual({
      kind: "agent_run",
      ref: "abcd1234-1111-2222-3333-444455556666",
      label: "run abcd1234",
    });
  });

  it("mixes memory + agent_run refs preserving order", () => {
    const out = buildCitationsFromContext({
      memoryHits: [{ slug: "ops" }],
      runRefs: [
        {
          run_id: "11111111-aaaa-bbbb-cccc-222233334444",
          label: "yesterday's run",
        },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("memory_doc");
    expect(out[1].kind).toBe("agent_run");
    expect(out[1].label).toBe("yesterday's run");
  });

  it("every output passes CitationSchema validation", () => {
    const out = buildCitationsFromContext({
      memoryHits: [{ slug: "company" }, { slug: "policies" }],
      runRefs: [
        { run_id: "abcd1234-1111-2222-3333-444455556666" },
      ],
    });
    for (const c of out) {
      expect(() => CitationSchema.parse(c)).not.toThrow();
    }
  });
});

describe("BODY_SCHEMAS — kind discriminator coverage", () => {
  it("has a schema for every THREAD_EVENT_KINDS value", () => {
    for (const k of THREAD_EVENT_KINDS) {
      expect(BODY_SCHEMAS[k]).toBeDefined();
    }
  });

  it("validates a real run_end body", () => {
    expect(() =>
      BODY_SCHEMAS.run_end.parse({ status: "success", cost_usd: 0.0123 }),
    ).not.toThrow();
    expect(() =>
      BODY_SCHEMAS.run_end.parse({ status: "success", cost_usd: null }),
    ).not.toThrow();
    expect(() =>
      BODY_SCHEMAS.run_end.parse({ status: "cancelled", cost_usd: 0 }),
    ).not.toThrow();
  });

  it("carries trigger + question through to the persisted run_end body", () => {
    expect(
      BODY_SCHEMAS.run_end.parse({
        status: "success",
        cost_usd: 0.01,
        answered: true,
        trigger: "channel_recipe",
        question: true,
      }),
    ).toMatchObject({ trigger: "channel_recipe", question: true });
    expect(() =>
      BODY_SCHEMAS.run_end.parse({ status: "error", cost_usd: null }),
    ).not.toThrow();
  });

  it("rejects unknown run_end status", () => {
    expect(() =>
      BODY_SCHEMAS.run_end.parse({ status: "weird", cost_usd: 0 }),
    ).toThrow();
  });

  it("enforces tool_call output_preview ≤200 chars (T-1 cap)", () => {
    const too_long = "x".repeat(201);
    expect(() =>
      BODY_SCHEMAS.tool_call.parse({
        tool_name: "persona.fetch_inquiry",
        target: "inq_3kPq",
        ms: 812,
        code: "ok",
        output_preview: too_long,
      }),
    ).toThrow();
  });

  it("accepts tool_call with error_message + code='err'", () => {
    expect(() =>
      BODY_SCHEMAS.tool_call.parse({
        tool_name: "persona.fetch_inquiry",
        target: "inq_3kPq",
        ms: 12000,
        code: "err",
        output_preview: "",
        error_message: "Timeout after 12s",
      }),
    ).not.toThrow();
  });

  it("enforces file_edit diff ≤4KB", () => {
    const huge_diff = "x".repeat(4097);
    expect(() =>
      BODY_SCHEMAS.file_edit.parse({
        path: "src/foo.ts",
        diff: huge_diff,
      }),
    ).toThrow();
  });

  it("rejects citation with wrong kind", () => {
    expect(() =>
      CitationSchema.parse({
        kind: "tenant_data",
        ref: "anything",
        label: "x",
      }),
    ).toThrow();
  });

  it("rejects citation with empty ref or label", () => {
    expect(() =>
      CitationSchema.parse({ kind: "memory_doc", ref: "", label: "x" }),
    ).toThrow();
    expect(() =>
      CitationSchema.parse({ kind: "memory_doc", ref: "x", label: "" }),
    ).toThrow();
  });
});

describe("runEndTrigger", () => {
  it("passes a run's own trigger through", () => {
    expect(runEndTrigger("chat", { thread_id: "t1" })).toBe("chat");
    expect(runEndTrigger("cron", null)).toBe("cron");
  });

  it("stamps a staff-console chat apart, so the customer is never notified for it", () => {
    expect(runEndTrigger("chat", { thread_id: "t1", origin: "staff_console" })).toBe("staff_console");
  });
});
