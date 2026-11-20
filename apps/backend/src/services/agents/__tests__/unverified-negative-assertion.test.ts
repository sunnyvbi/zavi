
import { describe, it, expect, afterEach } from "vitest";
import {
  settleOperatorToolResult,
  newToolCounters,
  OPERATOR_BUDGET_CAPS,
} from "../operator-policy";
import {
  recordGroundingReceipt,
  groundingReceipts,
  __resetGroundingReceiptsForTest,
} from "../engine/grounding-receipt-ledger";
import { isGithubRead, verifyNoUnverifiedAbsence } from "../unverified-absence-verifier";
import type { ToolCallTrace } from "@/services/tools/types";

describe("settleOperatorToolResult (P0.a)", () => {
  it("refunds a github__read_file that came back not_found", () => {
    const counters = newToolCounters();
    counters.set("github__read_file", 3);
    settleOperatorToolResult({
      tool_name: "github__read_file",
      is_error: true,
      code: "not_found",
      counters,
    });
    expect(counters.get("github__read_file")).toBe(2);
  });

  it("ANCHOR REPLAY: 5 not_found probes net-zero the counter, so the 12th read is still allowed", () => {
    const counters = newToolCounters();
    for (let i = 0; i < 5; i++) {
      counters.set("github__read_file", (counters.get("github__read_file") ?? 0) + 1);
      settleOperatorToolResult({
        tool_name: "github__read_file",
        is_error: true,
        code: "not_found",
        counters,
      });
    }
    expect(counters.get("github__read_file")).toBe(0);
    const cap = OPERATOR_BUDGET_CAPS.get("github__read_file")!;
    expect(cap).toBe(12);
    expect(counters.get("github__read_file")! < cap).toBe(true);
  });

  it("does NOT refund an empty search_code (is_error=false → not a miss)", () => {
    const counters = newToolCounters();
    counters.set("github__search_code", 4);
    settleOperatorToolResult({
      tool_name: "github__search_code",
      is_error: false,
      code: undefined,
      counters,
    });
    expect(counters.get("github__search_code")).toBe(4);
  });

  it("does NOT refund a 403 / rate-limit (is_error but code!=not_found)", () => {
    const counters = newToolCounters();
    counters.set("github__read_file", 4);
    settleOperatorToolResult({
      tool_name: "github__read_file",
      is_error: true,
      code: "secondary_rate_limit_403",
      counters,
    });
    expect(counters.get("github__read_file")).toBe(4);
  });

  it("does NOT refund a not_found on a non-refundable tool (search_code)", () => {
    const counters = newToolCounters();
    counters.set("github__search_code", 4);
    settleOperatorToolResult({
      tool_name: "github__search_code",
      is_error: true,
      code: "not_found",
      counters,
    });
    expect(counters.get("github__search_code")).toBe(4);
  });

  it("refunds memory__read not_found too", () => {
    const counters = newToolCounters();
    counters.set("memory__read", 2);
    settleOperatorToolResult({
      tool_name: "memory__read",
      is_error: true,
      code: "not_found",
      counters,
    });
    expect(counters.get("memory__read")).toBe(1);
  });

  it("floors at 0 — never goes negative", () => {
    const counters = newToolCounters();
    counters.set("github__read_file", 0);
    settleOperatorToolResult({
      tool_name: "github__read_file",
      is_error: true,
      code: "not_found",
      counters,
    });
    expect(counters.get("github__read_file")).toBe(0);
  });
});

describe("recordGroundingReceipt information-awareness (P0.b)", () => {
  afterEach(() => __resetGroundingReceiptsForTest());

  it("an empty search_code (hadInformation=false) mints NO repo_read receipt", () => {
    recordGroundingReceipt("run-empty", "github__search_code", false);
    expect(groundingReceipts("run-empty").has("repo_read")).toBe(false);
  });

  it("a search_code WITH hits mints a repo_read receipt", () => {
    recordGroundingReceipt("run-hit", "github__search_code", true);
    expect(groundingReceipts("run-hit").has("repo_read")).toBe(true);
  });

  it("a direct read_file always mints (default hadInformation=true)", () => {
    recordGroundingReceipt("run-read", "github__read_file");
    expect(groundingReceipts("run-read").has("repo_read")).toBe(true);
  });

  it("ANCHOR: 5 zero-hit soup searches certify NOTHING", () => {
    for (let i = 0; i < 5; i++) recordGroundingReceipt("run-soup", "github__search_code", false);
    expect(groundingReceipts("run-soup").size).toBe(0);
  });
});

describe("verifyNoUnverifiedAbsence (P1.a)", () => {
  const refusedReadTrace: ToolCallTrace[] = [
    {
      name: "github__read_file",
      input_preview: '{"path":"apps/web/components/Analytics/Analytics.tsx"}',
      output_preview: "BUDGET EXHAUSTED: `github__read_file` has been called 12 times this run (cap: 12).",
      ms: 0,
      status: "tool_error",
    },
  ];

  it("ANCHOR: hedges 'No Google Analytics or GTM found' when a read was budget-refused", () => {
    const r = verifyNoUnverifiedAbsence({
      reply: "Upcar: No Google Analytics or GTM found across the repo.",
      toolCalls: refusedReadTrace,
    });
    expect(r.hedged).toBe(true);
    expect(r.text).toContain("Unverified");
    expect(r.text).toContain("No Google Analytics or GTM found");
  });

  it("does NOT hedge when NO read was budget-refused (absence rests on completed reads)", () => {
    const okTrace: ToolCallTrace[] = [
      { name: "github__read_file", input_preview: "{}", output_preview: '{"content":"..."}', ms: 0, status: "ok" },
    ];
    const r = verifyNoUnverifiedAbsence({
      reply: "No analytics found in this file.",
      toolCalls: okTrace,
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge a non-absence reply even after a budget refusal", () => {
    const r = verifyNoUnverifiedAbsence({
      reply: "GA4 is wired via Analytics.tsx with container GTM-WDKQ4PHR.",
      toolCalls: refusedReadTrace,
    });
    expect(r.hedged).toBe(false);
  });

  it("is idempotent — an already-hedged reply is not re-hedged", () => {
    const first = verifyNoUnverifiedAbsence({
      reply: "No GTM found.",
      toolCalls: refusedReadTrace,
    });
    expect(first.hedged).toBe(true);
    const second = verifyNoUnverifiedAbsence({
      reply: first.text,
      toolCalls: refusedReadTrace,
    });
    expect(second.hedged).toBe(false);
    expect(second.text.match(/Unverified/g)?.length ?? 0).toBe(1);
  });

  it("an UNRESOLVED search-cap burnout DOES hedge an absence claim", () => {
    const searchBurnout: ToolCallTrace[] = [
      {
        name: "github__search_code",
        input_preview: "{}",
        output_preview: "BUDGET EXHAUSTED: `github__search_code` has been called 8 times this run (cap: 8).",
        ms: 0,
        status: "tool_error",
      },
    ];
    const r = verifyNoUnverifiedAbsence({ reply: "No GA found.", toolCalls: searchBurnout });
    expect(r.hedged).toBe(true);
    expect(r.flags.reason).toBe("blocked_read");
  });

  it("NON-STICKY: a failed lookup followed by a successful one does NOT hedge", () => {
    const recovered: ToolCallTrace[] = [
      {
        name: "github__search_code",
        input_preview: '{"query":"turo linkedAccount externalAccount rentalLink"}',
        output_preview: '{"total":0,"items":[]}',
        ms: 0,
        status: "ok",
      },
      {
        name: "github__search_code",
        input_preview: '{"query":"turo link"}',
        output_preview: '{"total":30,"items":[{"path":"apps/backend/src/utils/turoProfileUtils.ts"}]}',
        ms: 0,
        status: "ok",
      },
    ];
    const r = verifyNoUnverifiedAbsence({
      reply: "There is no separate Getaround import.",
      toolCalls: recovered,
    });
    expect(r.hedged).toBe(false);
  });

  it("a blocked github__grep + an absence claim hedges (the 2026-09-11 Turo shape)", () => {
    const blocked: ToolCallTrace[] = [
      {
        name: "mcp__server__github__grep",
        input_preview: '{"pattern":"turo|externalAccount"}',
        output_preview:
          '{"error":"approval_channel_unavailable","message":"This action (github__grep) requires approval but no approval channel is available on this run; blocked (fail-closed)."}',
        ms: 0,
        status: "tool_error",
      },
      {
        name: "mcp__server__github__search_code",
        input_preview: '{"query":"turo linkedAccount externalAccount rentalLink"}',
        output_preview: '{"total":0,"items":[]}',
        ms: 0,
        status: "ok",
      },
    ];
    const r = verifyNoUnverifiedAbsence({
      reply: "No such feature exists in the codebase — zero results for any Turo.",
      toolCalls: blocked,
    });
    expect(r.hedged).toBe(true);
    expect(r.text).toContain("Unverified");
  });

  it("a COMPLETE grep with zero matches is real evidence and does NOT hedge", () => {
    const cleanScan: ToolCallTrace[] = [
      {
        name: "github__grep",
        input_preview: '{"pattern":"zzqqxx","path_glob":"apps/backend/**"}',
        output_preview: '{"matches":[],"scanned_files":120,"candidate_files":120,"complete":true}',
        ms: 0,
        status: "ok",
      },
    ];
    const r = verifyNoUnverifiedAbsence({
      reply: "That handler does not exist in the backend.",
      toolCalls: cleanScan,
    });
    expect(r.hedged).toBe(false);
  });

  it("a run with NO code lookup hedges a product-absence claim, but not a non-code one", () => {
    const noLookup: ToolCallTrace[] = [
      { name: "google_calendar__list", input_preview: "{}", output_preview: "[]", ms: 0, status: "ok" },
    ];
    const code = verifyNoUnverifiedAbsence({
      reply: "There is no such feature in the codebase.",
      toolCalls: noLookup,
    });
    expect(code.hedged).toBe(true);
    expect(code.flags.reason).toBe("no_code_read");

    const nonCode = verifyNoUnverifiedAbsence({
      reply: "There are no meetings on your calendar tomorrow.",
      toolCalls: noLookup,
    });
    expect(nonCode.hedged).toBe(false);
  });

  it("does NOT hedge no_code_read when the run had no code-search tool at all", () => {
    const noLookup: ToolCallTrace[] = [
      { name: "google_calendar__list", input_preview: "{}", output_preview: "[]", ms: 0, status: "ok" },
    ];
    const r = verifyNoUnverifiedAbsence({
      reply: "There is no such feature in the codebase.",
      toolCalls: noLookup,
      codeSearchAvailable: false,
    });
    expect(r.hedged).toBe(false);
    expect(r.flags.reason).toBeNull();
  });

  it("UNKNOWN availability keeps the arm armed (bespoke dispatchers, old callers)", () => {
    const noLookup: ToolCallTrace[] = [
      { name: "google_calendar__list", input_preview: "{}", output_preview: "[]", ms: 0, status: "ok" },
    ];
    const r = verifyNoUnverifiedAbsence({
      reply: "There is no such feature in the codebase.",
      toolCalls: noLookup,
      codeSearchAvailable: undefined,
    });
    expect(r.hedged).toBe(true);
    expect(r.flags.reason).toBe("no_code_read");
  });

  it("still hedges a BUDGET-REFUSED read even when codeSearchAvailable is false", () => {
    const refused: ToolCallTrace[] = [
      {
        name: "github__read_file",
        input_preview: '{"path":"src/components/Analytics.tsx"}',
        output_preview: "BUDGET EXHAUSTED: read_file budget (8) consumed for this run.",
        ms: 0,
        status: "ok",
      },
    ];
    const r = verifyNoUnverifiedAbsence({
      reply: "No Google Analytics or GTM found.",
      toolCalls: refused,
      codeSearchAvailable: false,
    });
    expect(r.hedged).toBe(true);
    expect(r.flags.reason).toBe("read_budget");
  });

  it("still hedges the web arm when codeSearchAvailable is false", () => {
    const r = verifyNoUnverifiedAbsence({
      reply:
        "Turo doesn't publish their 12-month host retention rate. It's not in " +
        "their annual reports or any public disclosure I know of.",
      toolCalls: [],
      codeSearchAvailable: false,
    });
    expect(r.hedged).toBe(true);
    expect(r.flags.reason).toBe("no_web_search");
  });

  it("isGithubRead identifies code-lookup tools in a resolved tool set", () => {
    const has = (names: unknown[]) => names.some((n) => isGithubRead(n));
    expect(has(["github__grep", "web_search__search"])).toBe(true);
    expect(has(["mcp__zavi__github__read_file"])).toBe(true);
    expect(has(["web_search__search", "operator_db__query"])).toBe(false);
    expect(has([])).toBe(false);
    expect(isGithubRead(undefined)).toBe(false);
  });

  it("does NOT hedge an absence answered off a successful operator-DB read", () => {
    const dbRead: ToolCallTrace[] = [
      {
        name: "operator_db__catalog",
        input_preview: "{}",
        output_preview: '{"collections":["trips","guestreviews","carlistings"]}',
        ms: 12,
        status: "ok",
      },
    ];
    const r = verifyNoUnverifiedAbsence({
      reply:
        "Upcar doesn't collect NPS. There's no survey field in the schema and no data for any quarter. What exists is 1-5 star peer ratings on guestreviews.",
      toolCalls: dbRead,
    });
    expect(r.hedged).toBe(false);
  });

  it("still hedges a DB-shaped absence when the DB read ERRORED (no evidence landed)", () => {
    const failed: ToolCallTrace[] = [
      {
        name: "operator_db__catalog",
        input_preview: "{}",
        output_preview: "connection refused",
        ms: 3,
        status: "tool_error",
      },
    ];
    const r = verifyNoUnverifiedAbsence({
      reply: "There is no NPS field in your schema.",
      toolCalls: failed,
    });
    expect(r.hedged).toBe(true);
    expect(r.flags.reason).toBe("no_code_read");
  });

  it("a DB read does NOT clear a genuine github budget refusal", () => {
    const mixed: ToolCallTrace[] = [
      {
        name: "operator_db__query",
        input_preview: "{}",
        output_preview: '{"rows":[{"n":3}]}',
        ms: 9,
        status: "ok",
      },
      {
        name: "github__read_file",
        input_preview: '{"path":"Analytics.tsx"}',
        output_preview: "BUDGET EXHAUSTED: read cap reached",
        ms: 1,
        status: "ok",
      },
    ];
    const r = verifyNoUnverifiedAbsence({
      reply: "No Google Analytics is configured in the codebase.",
      toolCalls: mixed,
    });
    expect(r.hedged).toBe(true);
    expect(r.flags.reason).toBe("read_budget");
  });

  it("tolerates a missing/empty toolCalls (fail-open shape)", () => {
    const r = verifyNoUnverifiedAbsence({ reply: "No GA found.", toolCalls: undefined });
    expect(r.hedged).toBe(false);
  });

  const TURO_REPLY =
    "Turo doesn't publish their 12-month host retention rate. It's not in their " +
    "annual reports or any public disclosure I know of. Any specific figure I gave " +
    "you now would be training-data guesswork.";

  it("ANCHOR REPLAY: hedges an outside-world absence claim made with no open-web call", () => {
    const r = verifyNoUnverifiedAbsence({ reply: TURO_REPLY, toolCalls: [] });
    expect(r.hedged).toBe(true);
    expect(r.flags.reason).toBe("no_web_search");
    expect(r.text).toContain("I did not search the web this run");
    expect(r.flags.matched_phrases.length).toBeGreaterThan(0);
  });

  it("does NOT hedge the same claim once web_search actually ran", () => {
    const searched: ToolCallTrace[] = [
      {
        name: "mcp__server__web_search__search",
        input_preview: '{"query":"Turo S-1 host retention"}',
        output_preview: '{"results":[{"url":"https://sec.gov/...","title":"Turo S-1"}]}',
        ms: 900,
        status: "ok",
      },
    ];
    const r = verifyNoUnverifiedAbsence({ reply: TURO_REPLY, toolCalls: searched });
    expect(r.hedged).toBe(false);
  });

  it("a FAILED web_search does not count as having looked", () => {
    const failed: ToolCallTrace[] = [
      {
        name: "web_search__search",
        input_preview: '{"query":"Turo host retention"}',
        output_preview: "tavily timeout",
        ms: 5,
        status: "tool_error",
      },
    ];
    const r = verifyNoUnverifiedAbsence({ reply: TURO_REPLY, toolCalls: failed });
    expect(r.hedged).toBe(true);
    expect(r.flags.reason).toBe("no_web_search");
  });

  it("a private Google Doc read is NOT an open-web look", () => {
    const driveRead: ToolCallTrace[] = [
      {
        name: "mcp__server__web_fetch__fetch",
        input_preview: '{"url":"https://docs.google.com/document/d/abc123/edit"}',
        output_preview:
          '{"final_url":"https://docs.google.com/document/d/abc123/edit","status":200,"content_type":"text/plain","body_text":"Host onboarding runbook',
        ms: 400,
        status: "ok",
      },
    ];
    const r = verifyNoUnverifiedAbsence({ reply: TURO_REPLY, toolCalls: driveRead });
    expect(r.hedged).toBe(true);
    expect(r.flags.reason).toBe("no_web_search");
  });

  it("a genuine public fetch still counts as having looked", () => {
    const publicFetch: ToolCallTrace[] = [
      {
        name: "mcp__server__web_fetch__fetch",
        input_preview: '{"url":"https://www.sec.gov/Archives/turo-s1.htm"}',
        output_preview:
          '{"final_url":"https://www.sec.gov/Archives/turo-s1.htm","status":200,"body_text":"Host net revenue retention',
        ms: 900,
        status: "ok",
      },
    ];
    const r = verifyNoUnverifiedAbsence({ reply: TURO_REPLY, toolCalls: publicFetch });
    expect(r.hedged).toBe(false);
  });

  it("leaves an INTERNAL not-public answer alone (the arm is about outside publishers)", () => {
    const dbRead: ToolCallTrace[] = [
      {
        name: "operator_db__catalog",
        input_preview: "{}",
        output_preview: '{"collections":["trips"]}',
        ms: 8,
        status: "ok",
      },
    ];
    const r = verifyNoUnverifiedAbsence({
      reply: "Your listings repo is not public, so the raw URL won't resolve for guests.",
      toolCalls: dbRead,
    });
    expect(r.hedged).toBe(false);
  });
});
