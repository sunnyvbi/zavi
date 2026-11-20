
import { describe, it, expect } from "vitest";
import {
  smartTruncateToolResult,
  smartTruncateThenWrap,
  toolResultCapBytes,
  SDK_PERSISTED_OUTPUT_RE,
} from "../smart-truncate";
import { renderUntrustedBlock } from "../prompt-injection";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("toolResultCapBytes — shared budget, both engines", () => {
  it("defaults to 16KB, the measured typical-payload budget", () => {
    expect(toolResultCapBytes("slack", "get_channel_history")).toBe(16 * 1024);
    expect(toolResultCapBytes("github", "read_file")).toBe(16 * 1024);
  });

  it("preserves the deliberate 64KB peer-content-read exception", () => {
    expect(toolResultCapBytes("praxis_corpus", "read_run_output")).toBe(64 * 1024);
  });

  it("does not widen the exception to sibling praxis_corpus tools", () => {
    expect(toolResultCapBytes("praxis_corpus", "query_recent_runs")).toBe(16 * 1024);
  });

  it("gives operator_db catalog room for a whole-DB name index", () => {
    expect(toolResultCapBytes("operator_db", "catalog")).toBe(32 * 1024);
  });

  it("does not widen the catalog exception to operator_db reads", () => {
    expect(toolResultCapBytes("operator_db", "query")).toBe(16 * 1024);
    expect(toolResultCapBytes("operator_db", "query_user")).toBe(16 * 1024);
  });
});

describe("the 231-collection catalog index (run 0d04dc68)", () => {
  const REAL_NAMES = [
    "potentialusers", "rejectedusers", "superusers", "users", "useractionlogs",
    "useractivities", "carlistings", "trips", "bookingchatboxes", "bookingmessages",
    "giftcardtransactions", "communitychatmessages", "generalmessages", "guestreviews",
    "hostpayouts", "cronjobexecutions", "conversationanalyses", "tasks", "taskcomments",
    "clientissues", "feedbacks", "supportchats",
  ];
  const catalogIndex = (n: number) =>
    JSON.stringify({
      ready: true,
      dialect: "mongodb",
      total_collections: n,
      collections: Array.from({ length: n }, (_, i) =>
        i >= n - REAL_NAMES.length
          ? { name: REAL_NAMES[i - (n - REAL_NAMES.length)] }
          : { name: `discoveredcollection${i}` },
      ),
    });

  const CATALOG_CAP = toolResultCapBytes("operator_db", "catalog");

  it("fits the WHOLE index at the catalog budget — no paging", () => {
    const raw = catalogIndex(231);
    expect(bytes(raw)).toBeGreaterThan(2 * 1024);
    const out = smartTruncateToolResult(raw, CATALOG_CAP);
    expect(out).toBe(raw);
    expect(JSON.parse(out)._truncated).toBeUndefined();
  });

  it("still lists supportchats — the collection the agent said did not exist", () => {
    const out = smartTruncateToolResult(catalogIndex(231), CATALOG_CAP);
    expect(JSON.parse(out).collections.map((c: { name: string }) => c.name))
      .toContain("supportchats");
  });

  it("degrades to a valid _truncated envelope if a DB is bigger still", () => {
    const out = smartTruncateToolResult(catalogIndex(5000), CATALOG_CAP);
    expect(bytes(out)).toBeLessThanOrEqual(CATALOG_CAP);
    const parsed = JSON.parse(out);
    expect(parsed._truncated).toBe(true);
    expect(parsed._total ?? parsed.total_collections).toBe(5000);
  });

  it("recognizes `collections` as an item key at all", () => {
    const parsed = JSON.parse(smartTruncateToolResult(catalogIndex(5000), CATALOG_CAP));
    expect(Array.isArray(parsed.collections)).toBe(true);
    expect(parsed.collections.length).toBeGreaterThan(0);
    expect(parsed._returned).toBeGreaterThan(0);
  });
});

describe("SDK_PERSISTED_OUTPUT_RE — the alarm", () => {
  const REAL_MARKER =
    '"<persisted-output>\\nOutput too large (51.4KB). Full output saved to: ' +
    "/root/.claude/projects/-app-apps-backend/48be2bbd/tool-results/toolu_01VuS4Ja.json\\n\\n" +
    'Preview (first 2KB):\\n[\\n  {\\n    \\"type\\": \\"text\\",';

  it("matches the marker that actually shipped the bad answer", () => {
    expect(SDK_PERSISTED_OUTPUT_RE.test(REAL_MARKER)).toBe(true);
  });

  it("matches either half independently", () => {
    expect(SDK_PERSISTED_OUTPUT_RE.test("<persisted-output>")).toBe(true);
    expect(SDK_PERSISTED_OUTPUT_RE.test("Output too large (9.1KB).")).toBe(true);
  });

  it("does not fire on ordinary tool output", () => {
    expect(SDK_PERSISTED_OUTPUT_RE.test('{"collections":[{"name":"supportchats"}]}')).toBe(false);
    expect(SDK_PERSISTED_OUTPUT_RE.test('{"_truncated":true,"_total":231}')).toBe(false);
    expect(SDK_PERSISTED_OUTPUT_RE.test("the output was large but fine")).toBe(false);
  });
});

describe("smartTruncateThenWrap — untrusted markers survive", () => {
  const wrap = (body: string) => renderUntrustedBlock("tool_github", body);

  it("never exceeds the cap", () => {
    const raw = JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ i, body: "x".repeat(80) })) });
    const out = smartTruncateThenWrap(raw, 2 * 1024, wrap);
    expect(bytes(out)).toBeLessThanOrEqual(2 * 1024);
  });

  it("keeps the closing marker — the failure of wrap-then-slice", () => {
    const raw = JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ i, body: "x".repeat(80) })) });
    const out = smartTruncateThenWrap(raw, 2 * 1024, wrap);
    expect(out).toContain("<untrusted_tool_github>");
    expect(out).toContain("</untrusted_tool_github>");
  });

  it("passes small payloads through wrapped and intact", () => {
    const raw = JSON.stringify({ ok: true });
    const out = smartTruncateThenWrap(raw, 2 * 1024, wrap);
    expect(out).toBe(wrap(raw));
  });
});
