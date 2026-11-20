
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

vi.mock("@/services/redactor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/redactor")>();
  return {
    ...actual,
    redactValue: vi.fn(actual.redactValue),
  };
});

import { redactValue } from "@/services/redactor";
import {
  normalizeMessages,
  safeParseOpus,
  computeActualCents,
  makeIdempotencyKey,
  clampLen,
} from "../slack-channel-summarize";

const redactSpy = redactValue as unknown as ReturnType<typeof vi.fn>;

describe("normalizeMessages . redacts every text-bearing field (Codex P2.6)", () => {
  beforeEach(() => {
    redactSpy.mockClear();
  });

  it("calls redactValue on text, attachment text, block text, file names, display_name", () => {
    const m = [
      {
        ts: "1700000001.000001",
        text: "hello alice@example.com",
        user: "U001",
        profile: { display_name: "Alice" },
        attachments: [{ text: "see attached pdf" }],
        blocks: [{ text: { text: "block body text" } }],
        files: [{ name: "report.pdf" }],
        reactions: [{ count: 2 }, { count: 1 }],
        thread_ts: "1700000000.000000",
      },
    ];
    const out = normalizeMessages(m);
    expect(out.length).toBe(1);

    const calls = redactSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(4);

    const columns = calls.map((c) => c[0] as string);
    expect(columns).toContain("display_name");
    expect(columns).toContain("text");
    expect(columns).toContain("file_name");

    expect(out[0].text).toContain("‹redacted");
    expect(out[0].file_names).toContain("report.pdf");
    expect(out[0].reactions_count).toBe(3);
    expect(out[0].thread_ts).toBe("1700000000.000000");
  });

  it("does NOT pass permalinks through to the normalized shape (stripped)", () => {
    const m = [
      {
        ts: "1700000002.000002",
        text: "msg with permalink",
      },
    ];
    const out = normalizeMessages(m);
    expect(out[0]).not.toHaveProperty("permalinks");
    expect(out[0]).toHaveProperty("ts");
    expect(out[0]).toHaveProperty("user_label");
    expect(out[0]).toHaveProperty("text");
    expect(out[0]).toHaveProperty("quoted_text");
    expect(out[0]).toHaveProperty("file_names");
    expect(out[0]).toHaveProperty("reactions_count");
  });

  it("filters channel_join / channel_leave / channel_topic subtypes (no semantic payload)", () => {
    const m = [
      { ts: "1", subtype: "channel_join", user: "U1" },
      { ts: "2", subtype: "channel_leave", user: "U1" },
      { ts: "3", subtype: "channel_topic", user: "U1", text: "new topic" },
      { ts: "4", user: "U1", text: "real message" },
    ];
    const out = normalizeMessages(m);
    expect(out.length).toBe(1);
    expect(out[0].ts).toBe("4");
  });
});

describe("safeParseOpus . tolerates malformed JSON, returns default OpusOutput shape", () => {
  it("parses a well-formed JSON response into OpusOutput", () => {
    const input = JSON.stringify({
      summary_md: "## #marketing\nTeam discussed Q3 launch.",
      sidecar: {
        topics: ["launch", "Q3"],
        active_users: ["Alice", "Bob"],
        message_count: 42,
        distinct_user_count: 5,
      },
    });
    const out = safeParseOpus(input);
    expect(out.summary_md).toContain("Q3 launch");
    expect(out.sidecar.topics).toEqual(["launch", "Q3"]);
    expect(out.sidecar.active_users).toEqual(["Alice", "Bob"]);
    expect(out.sidecar.message_count).toBe(42);
    expect(out.sidecar.distinct_user_count).toBe(5);
  });

  it("tolerates ```json code-fence wrapping", () => {
    const input =
      "```json\n" +
      JSON.stringify({
        summary_md: "fenced",
        sidecar: { topics: [], active_users: [], message_count: 0, distinct_user_count: 0 },
      }) +
      "\n```";
    const out = safeParseOpus(input);
    expect(out.summary_md).toBe("fenced");
  });

  it("returns the default empty-sidecar shape on malformed JSON (does NOT throw)", () => {
    const out = safeParseOpus("not json at all { ");
    expect(out.summary_md).toBe("");
    expect(out.sidecar.topics).toEqual([]);
    expect(out.sidecar.active_users).toEqual([]);
    expect(out.sidecar.message_count).toBe(0);
    expect(out.sidecar.distinct_user_count).toBe(0);
  });

  it("filters non-string topics + non-string active_users", () => {
    const input = JSON.stringify({
      summary_md: "ok",
      sidecar: {
        topics: ["valid", 123, null, "also-valid"],
        active_users: [{ bad: "obj" }, "Alice"],
        message_count: "not-a-number",
        distinct_user_count: 7,
      },
    });
    const out = safeParseOpus(input);
    expect(out.sidecar.topics).toEqual(["valid", "also-valid"]);
    expect(out.sidecar.active_users).toEqual(["Alice"]);
    expect(out.sidecar.message_count).toBe(0);
    expect(out.sidecar.distinct_user_count).toBe(7);
  });
});

describe("computeActualCents . Sonnet 5.5 pricing math", () => {
  it("returns ceil($/cents) for a small sample", () => {
    const c = computeActualCents(1000, 100);
    expect(c).toBe(1);
  });

  it("ceilings any non-zero usage to >= 1 cent (Math.ceil contract)", () => {
    const c = computeActualCents(1, 1);
    expect(c).toBeGreaterThanOrEqual(1);
  });

  it("zero usage → 0 cents", () => {
    expect(computeActualCents(0, 0)).toBe(0);
  });

  it("scales linearly . 1M input tokens ≈ 200 cents", () => {
    const c = computeActualCents(1_000_000, 0);
    expect(c).toBe(200);
  });

  it("output tokens cost 5× input tokens at Sonnet 5.5 pricing", () => {
    const inOnly = computeActualCents(1_000_000, 0);
    const outOnly = computeActualCents(0, 1_000_000);
    expect(outOnly).toBe(5 * inOnly);
  });
});

describe("makeIdempotencyKey . deterministic sha256 over tenant|channel|run_date|action", () => {
  const T = "73db45ff-457e-4541-bc8f-bdb625390204";
  const CH = "C0123ABCDEF";
  const D = "2026-05-26";
  const A = "slack_summarize_run";

  it("returns the sha256 hex of `tenant|channel|run_date|action`", () => {
    const expected = createHash("sha256")
      .update(`${T}|${CH}|${D}|${A}`)
      .digest("hex");
    expect(makeIdempotencyKey(T, CH, D, A)).toBe(expected);
  });

  it("is deterministic . same inputs return same key", () => {
    const k1 = makeIdempotencyKey(T, CH, D, A);
    const k2 = makeIdempotencyKey(T, CH, D, A);
    expect(k1).toBe(k2);
  });

  it("is collision-free across distinct inputs (each component matters)", () => {
    const base = makeIdempotencyKey(T, CH, D, A);
    expect(makeIdempotencyKey("00000000-0000-0000-0000-000000000000", CH, D, A)).not.toBe(base);
    expect(makeIdempotencyKey(T, "C_OTHER", D, A)).not.toBe(base);
    expect(makeIdempotencyKey(T, CH, "2026-05-27", A)).not.toBe(base);
    expect(makeIdempotencyKey(T, CH, D, "slack_summarize_cap_hit")).not.toBe(base);
  });

  it("emits hex-only (64 chars)", () => {
    const k = makeIdempotencyKey(T, CH, D, A);
    expect(k).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("clampLen . caps at 1500 chars (the SUMMARY_MD_HARD_CAP_CHARS bound)", () => {
  it("returns the input untouched when under cap", () => {
    expect(clampLen("short", 1500)).toBe("short");
  });

  it("caps exactly at n chars, ending with ellipsis", () => {
    const s = "x".repeat(2000);
    const out = clampLen(s, 1500);
    expect(out.length).toBe(1500);
    expect(out.slice(-1)).toBe("…");
  });

  it("handles boundary: exactly 1500 chars input → returned untouched", () => {
    const s = "x".repeat(1500);
    expect(clampLen(s, 1500)).toBe(s);
  });

  it("handles boundary: 1501 chars → clamped to 1500", () => {
    const s = "x".repeat(1501);
    const out = clampLen(s, 1500);
    expect(out.length).toBe(1500);
  });
});
