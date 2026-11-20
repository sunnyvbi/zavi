import { describe, it, expect } from "vitest";
import { runGroundingChecks, hasHardGroundingFlag, type ToolCallLite } from "../grounding-checks";
import { SELF_CONTRADICTION_DOMAIN_AGENTS } from "../../guard-domains";

const viewCall = (path: string, a?: number, b?: number): ToolCallLite => ({
  name: "mcp__sandbox__view",
  status: "ok",
  input: a != null ? `{"path":"${path}","view_range":[${a},${b}]}` : `{"path":"${path}"}`,
  output: `{"content":"...lines..."}`,
});
const bash = (command: string, output = ""): ToolCallLite => ({
  name: "mcp__sandbox__run_bash",
  status: "ok",
  input: JSON.stringify({ command }),
  output,
});
const search = (total: number): ToolCallLite => ({
  name: "mcp__server__github__search_code",
  status: "ok",
  input: `{"input":{"query":"x"}}`,
  output: `{"total":${total},"items":[]}`,
});

describe("C1 line_cite_not_read", () => {
  it("clean when the cited line is inside a viewed range", () => {
    const r = runGroundingChecks({
      evidence: [viewCall("apps/backend/src/foo.ts", 1400, 1450)],
      agent_output: "The bug is at foo.ts:1406, in the guard.",
    });
    expect(r.flags.find((f) => f.pattern === "line_cite_not_read")).toBeUndefined();
  });
  it("flags a cite to a line that was never read", () => {
    const r = runGroundingChecks({
      evidence: [viewCall("apps/backend/src/foo.ts", 1400, 1450)],
      agent_output: "Cancel logic is at foo.ts:2408.",
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags[0].pattern).toBe("line_cite_not_read");
  });
  it("flags a cite when the file was never touched at all", () => {
    const r = runGroundingChecks({
      evidence: [search(5)],
      agent_output: "See users.model.ts:295.",
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags[0].detail).toMatch(/never read/);
  });
  it("treats a grep -n hit line as read", () => {
    const r = runGroundingChecks({
      evidence: [bash('grep -n "x" apps/backend/src/users.model.ts', '{"stdout":"users.model.ts:295:  lateReturnUser: boolean;"}')],
      agent_output: "Interface field at users.model.ts:295.",
    });
    expect(r.flags.find((f) => f.pattern === "line_cite_not_read")).toBeUndefined();
  });
  it("downgrades to SOFT when the file was only grepped and the line isn't in the (truncation-prone) grep output", () => {
    const r = runGroundingChecks({
      evidence: [bash('grep -n "x" apps/web/foo.tsx', '{"stdout":"foo.tsx:12:  const x = 1;"}')],
      agent_output: "Field at foo.tsx:973.",
    });
    const f = r.flags.find((x) => x.pattern === "line_cite_not_read");
    expect(f?.severity).toBe("soft");
    expect(hasHardGroundingFlag(r)).toBe(false);
  });
  it("treats a whole-file view (no range) as covering any line", () => {
    const r = runGroundingChecks({
      evidence: [viewCall("apps/web/foo.tsx")],
      agent_output: "Rendered at foo.tsx:4200.",
    });
    expect(r.flags.find((f) => f.pattern === "line_cite_not_read")).toBeUndefined();
  });
  it("honors a sed -n 'A,Bp' range", () => {
    const r = runGroundingChecks({
      evidence: [bash("sed -n '740,755p' apps/backend/src/users.model.ts")],
      agent_output: "Schema at users.model.ts:745.",
    });
    expect(r.flags.find((f) => f.pattern === "line_cite_not_read")).toBeUndefined();
  });
  it("ignores cites that appear only inside a fenced code block", () => {
    const r = runGroundingChecks({
      evidence: [],
      agent_output: "Here is the diff:\n```ts\n// foo.ts:9999\n```\nDone.",
    });
    expect(r.flags.find((f) => f.pattern === "line_cite_not_read")).toBeUndefined();
  });

  it("treats a `git show -- file` new-side hunk range as read (covers the cited line)", () => {
    const gitOut =
      '{"stdout":"diff --git a/apps/backend/src/services/cronjobs.ts b/apps/backend/src/services/cronjobs.ts\\nindex c634..e5a5 100644\\n--- a/apps/backend/src/services/cronjobs.ts\\n+++ b/apps/backend/src/services/cronjobs.ts\\n@@ -801,7 +801,24 @@ const updateTripStatuses = async () => {\\n+            const inlineIds = ...;\\n"}';
    const r = runGroundingChecks({
      evidence: [bash("git show ca5b7b3a -- apps/backend/src/services/cronjobs.ts", gitOut)],
      agent_output: "Cross-check against the TS hunk at apps/backend/src/services/cronjobs.ts:802-822.",
    });
    expect(r.flags.find((f) => f.pattern === "line_cite_not_read")).toBeUndefined();
  });

  it("still HARD-flags a `git show` cite to a line OUTSIDE every shown hunk (not just silencing C1)", () => {
    const gitOut =
      '{"stdout":"diff --git a/apps/backend/src/services/cronjobs.ts b/apps/backend/src/services/cronjobs.ts\\n@@ -700,5 +700,5 @@\\n+  const x = 1;\\n"}';
    const r = runGroundingChecks({
      evidence: [bash("git show ca5b7b3a -- apps/backend/src/services/cronjobs.ts", gitOut)],
      agent_output: "See cronjobs.ts:802 for the guard.",
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags[0].pattern).toBe("line_cite_not_read");
  });

  it("downgrades to SOFT when the diff section is present but the `@@` header was truncated out", () => {
    const truncated =
      '{"stdout":"diff --git a/apps/backend/src/services/cronjobs.ts b/apps/backend/src/services/cronjobs.ts\\nindex c634..e5a5 100644\\n--- a/apps/backend/src/services/cronjobs.ts\\n+++ b/apps/backend/src/services/cronjobs.ts\\n[truncated]"}';
    const r = runGroundingChecks({
      evidence: [bash("git show ca5b7b3a -- apps/backend/src/services/cronjobs.ts", truncated)],
      agent_output: "Cross-check against cronjobs.ts:802-822.",
    });
    const f = r.flags.find((x) => x.pattern === "line_cite_not_read");
    expect(f?.severity).toBe("soft");
    expect(hasHardGroundingFlag(r)).toBe(false);
  });

  it("credits a `git show <rev>:path` blob as a whole-file read", () => {
    const blob = '{"stdout":"export const updateTripStatuses = async () => {\\n  // ... full file ...\\n};\\n"}';
    const r = runGroundingChecks({
      evidence: [bash("git show HEAD:apps/backend/src/services/cronjobs.ts", blob)],
      agent_output: "Logic at cronjobs.ts:815.",
    });
    expect(r.flags.find((f) => f.pattern === "line_cite_not_read")).toBeUndefined();
  });

  it("does NOT credit a `git diff --name-only` (mentions file, no content)", () => {
    const r = runGroundingChecks({
      evidence: [bash("git diff --name-only", '{"stdout":"apps/backend/src/services/cronjobs.ts\\n"}')],
      agent_output: "Changed at cronjobs.ts:802.",
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags[0].detail).toMatch(/never read/);
  });

  it("does NOT credit a NON-git command whose output merely contains patch-looking text", () => {
    const fake =
      '{"stdout":"diff --git a/apps/backend/src/services/cronjobs.ts b/apps/backend/src/services/cronjobs.ts\\n@@ -801,7 +801,24 @@\\n+x\\n"}';
    const r = runGroundingChecks({
      evidence: [bash("echo somefile.patch", fake)],
      agent_output: "See cronjobs.ts:802.",
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags[0].detail).toMatch(/never read/);
  });

  it("handles a `git show <rev>:path` blob for a `[id].tsx`-style filename without a regex crash", () => {
    const blob = '{"stdout":"export default function Page() { return null; }\\n"}';
    const r = runGroundingChecks({
      evidence: [bash("git show HEAD:apps/web/app/car/[id].tsx", blob)],
      agent_output: "Rendered at [id].tsx:42.",
    });
    expect(r.flags.find((f) => f.pattern === "line_cite_not_read")).toBeUndefined();
  });

  it("downgrades to SOFT when the cited file:line was supplied in the inbound context", () => {
    const r = runGroundingChecks({
      input: "Fix the urgent SMS bug at apps/backend/src/services/cronjobs.ts:802 — inline the trip IDs.",
      evidence: [search(3)],
      agent_output: "Done — the change is in cronjobs.ts:802.",
    });
    const f = r.flags.find((x) => x.pattern === "line_cite_not_read");
    expect(f?.severity).toBe("soft");
    expect(hasHardGroundingFlag(r)).toBe(false);
  });

  it("is range-aware: an inbound `file:100-140` covers an output cite to line 120", () => {
    const r = runGroundingChecks({
      input: "See app.ts:100-140 for the router setup.",
      evidence: [search(1)],
      agent_output: "The guard is at app.ts:120.",
    });
    expect(hasHardGroundingFlag(r)).toBe(false);
  });

  it("still HARD-flags a cite that is in NEITHER tools NOR inbound context (genuine fabrication)", () => {
    const r = runGroundingChecks({
      input: "Please look into the slow checkout flow.",
      evidence: [search(3)],
      agent_output: "The bug is at checkout.ts:991.",
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags[0].pattern).toBe("line_cite_not_read");
  });

  it("does NOT exempt a DIFFERENT line in the same inbound file (inbound :100 ≠ output :991)", () => {
    const r = runGroundingChecks({
      input: "Start at app.ts:100.",
      evidence: [search(3)],
      agent_output: "Actually the real bug is at app.ts:991.",
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
  });

  it("a fabricated cite absent from the inbound snapshot stays HARD (no self-exemption)", () => {
    const r = runGroundingChecks({
      input: "Inline the trip IDs into the urgent SMS.",
      evidence: [search(2)],
      agent_output: "Fixed at cronjobs.ts:802 and validated.",
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
  });
});

describe("C4 tc0_state_claim", () => {
  it("flags a tc=0 run that asserts /approvals state", () => {
    const r = runGroundingChecks({
      evidence: [],
      agent_output: "The proposal is sitting in /approvals waiting for your click.",
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags.some((f) => f.pattern === "tc0_state_claim")).toBe(true);
  });
  it("does NOT flag a tc=0 predicted plan with no state claim", () => {
    const r = runGroundingChecks({
      evidence: [],
      agent_output: "## Plan\nI will read adminUserController.ts and add the field.",
    });
    expect(r.flags.some((f) => f.pattern === "tc0_state_claim")).toBe(false);
  });
  it("does NOT fire C4 when tools ran (only tc=0 case)", () => {
    const r = runGroundingChecks({
      evidence: [viewCall("a.ts", 1, 10)],
      agent_output: "It is already staged in /approvals.",
    });
    expect(r.flags.some((f) => f.pattern === "tc0_state_claim")).toBe(false);
  });
});

describe("C6 tool_count_mismatch", () => {
  it("flags '0 hits' when a search returned >0", () => {
    const r = runGroundingChecks({
      evidence: [search(14)],
      agent_output: "next-themes ThemeProvider — 0 hits. No dark mode infra.",
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags.some((f) => f.pattern === "tool_count_mismatch")).toBe(true);
  });
  it("clean when '0 hits' matches an actual empty search", () => {
    const r = runGroundingChecks({
      evidence: [search(0)],
      agent_output: "getUserData — 0 hits, doesn't exist.",
    });
    expect(r.flags.some((f) => f.pattern === "tool_count_mismatch")).toBe(false);
  });
});

describe("C2 search_not_read (soft)", () => {
  it("soft-flags a safety claim with only search_code", () => {
    const r = runGroundingChecks({
      evidence: [search(6), search(4)],
      agent_output: "Yes, safe — display-only, no money moves.",
    });
    expect(r.flags.some((f) => f.pattern === "search_not_read" && f.severity === "soft")).toBe(true);
    expect(hasHardGroundingFlag(r)).toBe(false);
  });
  it("does NOT flag when a view produced contents", () => {
    const r = runGroundingChecks({
      evidence: [viewCall("a.ts", 1, 50)],
      agent_output: "It's safe — display-only.",
    });
    expect(r.flags.some((f) => f.pattern === "search_not_read")).toBe(false);
  });
});

describe("C3 over_generalization (soft)", () => {
  it("soft-flags an 'all N sites' blanket claim", () => {
    const r = runGroundingChecks({
      evidence: [bash('grep -n "addedBy" x.ts', "")],
      agent_output: "Verified all 18 push sites pass addedBy, no behavior change.",
    });
    expect(r.flags.some((f) => f.pattern === "over_generalization")).toBe(true);
  });
});

describe("C8 unsupported_quant_claim (operator-DB / business-fact domain)", () => {
  const okTool = (output: string): ToolCallLite => ({
    name: "mcp__server__operator_db__query",
    status: "ok",
    input: `{"collection":"bookings"}`,
    output,
  });

  it("HARD-flags an invented $196/day live-DB-state figure with zero successful tool reads", () => {
    const r = runGroundingChecks({
      evidence: [],
      input: "How is revenue looking?",
      agent_output: "Your revenue is $196/day right now across active listings.",
      checkUnsupportedQuant: true,
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(true);
  });

  it("does NOT flag when the check is off (generic chat surface)", () => {
    const r = runGroundingChecks({
      evidence: [],
      input: "How is revenue looking?",
      agent_output: "Your revenue is $196/day right now across active listings.",
    });
    expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(false);
  });

  it("does NOT flag a figure recited from the fed-in context (hydration exemption)", () => {
    const r = runGroundingChecks({
      evidence: [],
      input: "Last week your revenue was $196/day. Summarize.",
      agent_output: "As you noted, revenue is $196/day — steady week over week.",
      checkUnsupportedQuant: true,
    });
    expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(false);
  });

  it("HARD-flags a confabulated pricing FORMULA + cost figures '(from code)' with no tool backing (trip-14424 class)", () => {
    const r = runGroundingChecks({
      evidence: [],
      input: "Why is trip 14424's extension costing more than $200?",
      agent_output:
        "Extension formula (from code): `daily_rate + max(daily_rate * plan_pct, floor_per_day)`. At $150/day on the Standard plan the extension cost works out to $210.",
      checkUnsupportedQuant: true,
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(true);
  });

  it("does NOT hard-flag a conversational '3 options' / '5 minutes' even with the check on", () => {
    const r = runGroundingChecks({
      evidence: [],
      input: "What should I do?",
      agent_output: "Here are 3 options; each takes about 5 minutes to set up.",
      checkUnsupportedQuant: true,
    });
    expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(false);
  });

  describe("general founder-ADVICE does not hard-flag (illustrative figures)", () => {
    const advice: Array<[string, string]> = [
      ["SMB pricing aside", "The SMB pricing ($500/mo) was flagged as unsustainable — high churn, no expansion."],
      ["generic take-rate aside", "RBF lenders typically want a 25% take rate on predictable revenue."],
      ["ACV band", "Mid-market target (ACV $50K-250K+) hits the $10M ARR goal."],
      ["RBF repayment cap", "You repay a % of monthly revenue until a cap is hit, typically 1.3-2x the advance."],
      ["lender rate band", "Venture debt lenders extend credit at roughly 20-30% of your equity round size."],
      ["AE cost aside", "A dedicated sales team runs about $250-400K/year per AE."],
    ];
    for (const [label, output] of advice) {
      it(`does NOT hard-flag: ${label}`, () => {
        const r = runGroundingChecks({
          evidence: [],
          input: "Do I need prior VC raises for venture debt?",
          agent_output: output,
          checkUnsupportedQuant: true,
        });
        expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(false);
      });
    }
  });

  describe("TENANT-state figures still hard-flag (the narrowing must not open a hole)", () => {
    it("HARD-flags a take-rate fabrication with no live read (2026-07-13 incident class)", () => {
      const r = runGroundingChecks({
        evidence: [],
        input: "how are we doing as a company?",
        agent_output: "Your blended take rate is 39%.",
        checkUnsupportedQuant: true,
      });
      expect(hasHardGroundingFlag(r)).toBe(true);
      expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(true);
    });

    it("HARD-flags a second-person earning claim ('you're pulling in $5,000/day')", () => {
      const r = runGroundingChecks({
        evidence: [],
        input: "how's the business?",
        agent_output: "You're pulling in $5,000/day at the moment.",
        checkUnsupportedQuant: true,
      });
      expect(hasHardGroundingFlag(r)).toBe(true);
    });

    it("HARD-flags 'you charge $65/day' with no live read", () => {
      const r = runGroundingChecks({
        evidence: [],
        input: "what do I charge?",
        agent_output: "You charge $65/day on the Standard plan.",
        checkUnsupportedQuant: true,
      });
      expect(hasHardGroundingFlag(r)).toBe(true);
    });

    it.each([
      ["past tense", "Net revenue was $34,874 last month."],
      ["came in at", "GMV came in at $54,024 this month."],
      ["figure-first", "You did $196/day in revenue across active listings."],
      ["current price", "The current price is $65/day on that listing."],
    ])("HARD-flags a tenant figure phrased as %s", (_label, output) => {
      const r = runGroundingChecks({
        evidence: [],
        input: "how are we doing?",
        agent_output: output,
        checkUnsupportedQuant: true,
      });
      expect(hasHardGroundingFlag(r)).toBe(true);
    });

    it("HARD-flags a tenant-scoped per-unit rate ('Trip 14424 extension: $493/day')", () => {
      const r = runGroundingChecks({
        evidence: [],
        input: "why is trip 14424 so expensive?",
        agent_output: "Trip 14424 extension: $493/day for 3 days.",
        checkUnsupportedQuant: true,
      });
      expect(hasHardGroundingFlag(r)).toBe(true);
    });
  });

  it("does NOT flag when a successful non-empty tool result grounds the figure", () => {
    const r = runGroundingChecks({
      evidence: [okTool(`{"rows":[{"revenue_per_day":196}],"row_count":1}`)],
      input: "How is revenue?",
      agent_output: "Your revenue is $196/day across active listings.",
      checkUnsupportedQuant: true,
    });
    expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(false);
  });

  it("DERIVED-SOFT: a computed figure shown via a table + formula, backed by a real read, is SOFT not HARD (no banner)", () => {
    const r = runGroundingChecks({
      evidence: [
        okTool(`{"rows":[{"gmv":54024,"tax":1828,"trips":102}],"row_count":1}`),
        okTool(`{"rows":[{"host_payouts":17322}],"row_count":1}`),
      ],
      input: "what is our revenue this month?",
      agent_output:
        "| Metric | Amount |\n|---|---|\n| GMV | $54,024 |\n| Host payouts | $17,322 |\n\n**Platform gross** (GMV − host payouts − tax) is **$34,874**.",
      checkUnsupportedQuant: true,
    });
    const f = r.flags.find((x) => x.pattern === "unsupported_quant_claim");
    expect(f).toBeTruthy();
    expect(f?.severity).toBe("soft");
    expect(hasHardGroundingFlag(r)).toBe(false);
  });

  it("FABRICATION-HARD: a bare unrelated figure with a read but NO shown derivation stays HARD (preserves 'queried bookings, invented revenue')", () => {
    const r = runGroundingChecks({
      evidence: [okTool(`{"rows":[{"bookings":102}],"row_count":1}`)],
      input: "how are we doing?",
      agent_output: "Your MRR is $9,999 right now.",
      checkUnsupportedQuant: true,
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(true);
  });

  it("NO-READ-HARD: a derivation-styled reply with ZERO successful data reads still HARD-flags (shown work without data is not grounding)", () => {
    const r = runGroundingChecks({
      evidence: [],
      input: "what is our revenue?",
      agent_output:
        "| Metric | Amount |\n|---|---|\n| GMV | $54,024 |\n\nPlatform gross (GMV − payouts − tax) is $34,874.",
      checkUnsupportedQuant: true,
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
  });

  it("PER-CLAIM-HARD: a cosmetic table elsewhere does NOT exempt an UNRELATED invented number in a bare sentence (codex prosecutor 2026-06-25)", () => {
    const r = runGroundingChecks({
      evidence: [okTool(`{"rows":[{"bookings":102}],"row_count":1}`)],
      input: "how are we doing?",
      agent_output:
        "| Metric | Value |\n|---|---|\n| Bookings | 102 |\n\nYour MRR is $9,999 right now.",
      checkUnsupportedQuant: true,
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(true);
  });

  it("HARD-flags a fabricated figure that is only a SUBSTRING of a real tool figure (no digit-soup false-negative)", () => {
    const r = runGroundingChecks({
      evidence: [okTool(`{"rows":[{"gross_revenue":4200}],"row_count":1}`)],
      input: "How is revenue?",
      agent_output: "Your revenue is $420/day across active listings.",
      checkUnsupportedQuant: true,
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(true);
  });

  it("DOES flag when the tool result was empty (empty grounds 'not found', not a quantity)", () => {
    const r = runGroundingChecks({
      evidence: [okTool(`{"rows":[],"row_count":0}`)],
      input: "How is revenue?",
      agent_output: "Your revenue is $196/day across active listings.",
      checkUnsupportedQuant: true,
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(true);
  });

  it("DOES flag when the only tool call errored (failure grounds nothing)", () => {
    const r = runGroundingChecks({
      evidence: [
        {
          name: "mcp__server__operator_db__query",
          status: "tool_error",
          input: `{"collection":"bookings"}`,
          output: `{"error":"operator_db_not_connected"}`,
        },
      ],
      input: "How is revenue?",
      agent_output: "Your GMV is $12,400 this month.",
      checkUnsupportedQuant: true,
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(true);
  });

  it("PER-CLAIM: a successful bookings query does NOT ground a fabricated revenue figure not in any output", () => {
    const r = runGroundingChecks({
      evidence: [okTool(`{"rows":[{"city":"Austin","bookings_n":37}],"row_count":1}`)],
      input: "How are we doing?",
      agent_output:
        "Bookings look healthy in Austin. Your revenue is $4,200 this month across active listings.",
      checkUnsupportedQuant: true,
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(true);
    expect(r.flags.find((f) => f.pattern === "unsupported_quant_claim")?.detail).toMatch(/4,?200/);
  });

  it("PER-CLAIM: a figure that DOES appear in a successful tool output is NOT flagged", () => {
    const r = runGroundingChecks({
      evidence: [okTool(`{"rows":[{"city":"Austin","revenue":4200}],"row_count":1}`)],
      input: "How are we doing?",
      agent_output: "Your revenue is $4,200 this month across active listings.",
      checkUnsupportedQuant: true,
    });
    expect(r.flags.some((f) => f.pattern === "unsupported_quant_claim")).toBe(false);
  });

  it("PER-CLAIM: grounds the recited figure but FLAGS a sibling fabricated figure in the same reply", () => {
    const r = runGroundingChecks({
      evidence: [okTool(`{"rows":[{"active_bookings":37}],"row_count":1}`)],
      input: "Status?",
      agent_output:
        "There are 37 active bookings. Your GMV is $9,900 this month.",
      checkUnsupportedQuant: true,
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags.find((f) => f.pattern === "unsupported_quant_claim")?.detail).toMatch(/9,?900/);
  });
});

describe("clean output", () => {
  it("a fully-grounded answer has zero flags", () => {
    const r = runGroundingChecks({
      evidence: [viewCall("apps/backend/src/foo.ts", 1400, 1450), bash('grep -n "x" foo.ts', "")],
      agent_output: "The guard at foo.ts:1410 is the issue; I read the surrounding code.",
    });
    expect(r.flags).toHaveLength(0);
    expect(r.hint).toBe("clean");
  });
});

const dbQuery = (input: string, output: string): ToolCallLite => ({
  name: "mcp__server__operator_db__query",
  status: "ok",
  input,
  output,
});

const TRIP_OUTPUT =
  '{"_id":"15677","status":"confirmed","paymentStatus":"paylater","isPaid":false,"pendingPaymentId":"6a3ac83302fc1f3909cf9495"}';
const SPECULATION =
  "Your pay-later is working correctly. What you likely saw is a temporary authorization hold; it will drop off on its own in 3-7 days or convert to the scheduled future charge closer to your trip date.";

describe("C9 linked_record_status_unread", () => {
  it("FIRES on the trip-15677 shape: held pendingPaymentId never dereferenced + payment-mechanics speculation", () => {
    const r = runGroundingChecks({
      input: "why was I charged on trip 15677 even though I chose pay later?",
      evidence: [dbQuery('{"collection":"trips","filter":{"_id":"15677"}}', TRIP_OUTPUT)],
      agent_output: SPECULATION,
      agentSlug: "support-lead",
      checkLinkedRecord: true,
    });
    expect(hasHardGroundingFlag(r)).toBe(true);
    expect(r.flags.find((f) => f.pattern === "linked_record_status_unread")).toBeTruthy();
  });

  it("SOFT (telemetry only) when several linked ids are held: a sentence cannot be tied to the unread one", () => {
    const r = runGroundingChecks({
      input: "why was I charged?",
      evidence: [
        dbQuery('{"collection":"trips"}', '{"paymentIntentId":"pi_A12345","refundId":"re_B12345"}'),
        dbQuery('{"id":"pi_A12345"}', '{"status":"requires_capture"}'),
      ],
      agent_output: "Your authorization hold will drop off on Friday.",
      agentSlug: "support-lead",
      checkLinkedRecord: true,
    });
    const f = r.flags.find((x) => x.pattern === "linked_record_status_unread");
    expect(f?.severity).toBe("soft");
    expect(hasHardGroundingFlag(r)).toBe(false);
  });

  it("HARD when several linked ids are held and NONE was read: nothing could ground the claim", () => {
    const r = runGroundingChecks({
      input: "why was I charged?",
      evidence: [
        dbQuery('{"collection":"trips"}', '{"paymentIntentId":"pi_A12345","refundId":"re_B12345"}'),
      ],
      agent_output: "Your authorization hold will drop off on Friday.",
      agentSlug: "support-lead",
      checkLinkedRecord: true,
    });
    const f = r.flags.find((x) => x.pattern === "linked_record_status_unread");
    expect(f?.severity).toBe("hard");
  });

  it("CLEAN once the pendingPaymentId is dereferenced (queried by id in a successful tool input)", () => {
    const r = runGroundingChecks({
      input: "why was I charged on trip 15677?",
      evidence: [
        dbQuery('{"collection":"trips","filter":{"_id":"15677"}}', TRIP_OUTPUT),
        dbQuery(
          '{"collection":"pendingpayments","filter":{"_id":"6a3ac83302fc1f3909cf9495"}}',
          '{"status":"failed","amountDue":63.72}',
        ),
      ],
      agent_output: SPECULATION,
      agentSlug: "support-lead",
      checkLinkedRecord: true,
    });
    expect(r.flags.find((f) => f.pattern === "linked_record_status_unread")).toBeUndefined();
  });

  it("CLEAN when the answer makes no payment-mechanics speculation (states only the read parent fields)", () => {
    const r = runGroundingChecks({
      input: "why was I charged on trip 15677?",
      evidence: [dbQuery('{"collection":"trips","filter":{"_id":"15677"}}', TRIP_OUTPUT)],
      agent_output: "Your trip shows pay-later selected and isPaid=false. Nothing is collected yet.",
      agentSlug: "support-lead",
      checkLinkedRecord: true,
    });
    expect(r.flags.find((f) => f.pattern === "linked_record_status_unread")).toBeUndefined();
  });

  it("OFF by default — the gate must be opted in (generic chat never fires)", () => {
    const r = runGroundingChecks({
      input: "why was I charged on trip 15677?",
      evidence: [dbQuery('{"collection":"trips","filter":{"_id":"15677"}}', TRIP_OUTPUT)],
      agent_output: SPECULATION,
      agentSlug: "support-lead",
    });
    expect(r.flags.find((f) => f.pattern === "linked_record_status_unread")).toBeUndefined();
  });

  it("CLEAN when no linked-record id was ever held (nothing to dereference)", () => {
    const r = runGroundingChecks({
      input: "is my account verified?",
      evidence: [dbQuery('{"collection":"users","filter":{"_id":"1002174"}}', '{"verified":true}')],
      agent_output: "What you likely saw is an authorization hold that drops off in a few days.",
      agentSlug: "support-lead",
      checkLinkedRecord: true,
    });
    expect(r.flags.find((f) => f.pattern === "linked_record_status_unread")).toBeUndefined();
  });
});

const selfContradiction = (output: string, evidence: ToolCallLite[] = []) =>
  runGroundingChecks({
    input: "how did last month go?",
    evidence,
    agent_output: output,
    agentSlug: "chief-of-staff",
    checkSelfContradiction: true,
  }).flags.filter((f) => f.pattern === "self_contradiction");

const TEXAS_TABLE = [
  "| Market | Active cars |",
  "| --- | --- |",
  "| Austin | 61 |",
  "| Dallas | 48 |",
  "| Houston | 39 |",
  "| San Antonio | 15 |",
].join("\n");

describe("C11 self_contradiction — the shapes it must catch", () => {
  it("(a) COUNT vs ENUMERATION: 'Three things drove it' over FOUR numbered drivers", () => {
    const flags = selfContradiction(
      [
        "Revenue fell 12% last month. Three things drove it:",
        "",
        "1. Meta CPM up 41% week over week",
        "2. The pricing test cut checkout conversion",
        "3. Two large hosts paused their fleets",
        "4. Seasonality in the Austin market",
      ].join("\n"),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].detail).toMatch(/Three things/);
    expect(flags[0].detail).toMatch(/4 top-level items/);
  });

  it("(a) also catches the digit form, and the other direction (list SHORTER than the count)", () => {
    const flags = selfContradiction(
      ["The 4 drivers, in order of impact:", "", "- CPM", "- Conversion", "- Supply"].join("\n"),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].detail).toMatch(/3 top-level items/);
  });

  it("(b) STATED TOTAL vs ITS OWN BREAKDOWN: 'Texas has 220 active cars' over a table summing to 163", () => {
    const flags = selfContradiction(
      ["Texas has 220 active cars on the platform.", "", TEXAS_TABLE].join("\n"),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].detail).toMatch(/"220"/);
    expect(flags[0].detail).toMatch(/sums to 163/);
  });

  it("(b) an APPROXIMATE total still fires when it is nowhere near the sum", () => {
    const flags = selfContradiction(
      ["We have about 220 active cars in Texas.", "", TEXAS_TABLE].join("\n"),
    );
    expect(flags).toHaveLength(1);
  });

  it("finds a contradiction with ZERO tool calls — it reads only the answer", () => {
    expect(
      selfContradiction(["Two issues are blocking launch:", "", "- A", "- B", "- C"].join("\n")),
    ).toHaveLength(1);
  });

  it("is SOFT — telemetry only, it must never trip a customer-facing hard-flag banner", () => {
    const r = runGroundingChecks({
      evidence: [],
      agent_output: ["Three things drove it:", "", "- A", "- B", "- C", "- D"].join("\n"),
      agentSlug: "chief-of-staff",
      checkSelfContradiction: true,
    });
    expect(r.flags.find((f) => f.pattern === "self_contradiction")?.severity).toBe("soft");
    expect(hasHardGroundingFlag(r)).toBe(false);
    expect(r.hint).toBe("review");
  });
});

describe("C11 self_contradiction — legitimate output that must stay CLEAN", () => {
  it("a count that MATCHES its list", () => {
    expect(
      selfContradiction(["Three things drove it:", "", "1. CPM", "2. Conversion", "3. Supply"].join("\n")),
    ).toEqual([]);
  });

  it("sub-bullets are not extra things", () => {
    expect(
      selfContradiction(
        [
          "Three things drove it:",
          "",
          "- Meta CPM up 41%",
          "  - Austin worst hit",
          "  - Dallas next",
          "- The pricing test cut conversion",
          "  - Reverted Friday",
          "- Two hosts paused their fleets",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a closing caveat bullet after the counted items is a note, not a fourth item", () => {
    expect(
      selfContradiction(
        [
          "Three things drove it:",
          "",
          "- CPM",
          "- Conversion",
          "- Supply",
          "- Note: attribution here is modelled, not measured.",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a closing caveat PARAGRAPH after the list", () => {
    expect(
      selfContradiction(
        [
          "Three things drove it:",
          "",
          "- CPM",
          "- Conversion",
          "- Supply",
          "",
          "All three are attributed from Meta's own reporting window, so treat them as directional.",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a trailing note under a NUMBERED list (marker switch ends the count)", () => {
    expect(
      selfContradiction(
        ["Three things drove it:", "", "1. CPM", "2. Conversion", "3. Supply", "- Pulled 2026-09-18."].join("\n"),
      ),
    ).toEqual([]);
  });

  it("an APPROXIMATE count ('about three things') against a longer list", () => {
    expect(
      selfContradiction(
        ["About three things drove it:", "", "- A", "- B", "- C", "- D", "- E"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a subset denominator ('three of the five markets') is not a count of the list", () => {
    expect(
      selfContradiction(
        ["Three of the five markets improved:", "", "- Austin", "- Dallas", "- Houston"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("two counts in one sentence (the list may hold either, both, or the sum)", () => {
    expect(
      selfContradiction(
        ["We tested 3 channels and 2 creative formats:", "", "- A", "- B", "- C", "- D"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a time-window noun ('the next three weeks') is not an enumeration count", () => {
    expect(
      selfContradiction(
        ["In the next three weeks we will ship:", "", "- A", "- B", "- C", "- D", "- E"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a list that is NOT adjacent to the count (prose in between)", () => {
    expect(
      selfContradiction(
        [
          "Three things drove it, and I unpack each below.",
          "",
          "First, some context on where these numbers come from.",
          "",
          "- Meta reporting",
          "- The operator DB",
          "- Your own Slack notes",
          "- Stripe payouts",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a restarted / non-contiguous numbering — the check declines rather than guesses", () => {
    expect(
      selfContradiction(
        [
          "Three things drove it:",
          "",
          "1. CPM",
          "2. Conversion",
          "3. Supply",
          "",
          "1. Unrelated follow-up",
          "2. Second follow-up",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a list inside a fenced code block is quoted material, not the answer's enumeration", () => {
    expect(
      selfContradiction(
        ["Three things drove it:", "", "```text", "- A", "- B", "- C", "- D", "```"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("(b) a total that MATCHES its breakdown", () => {
    expect(
      selfContradiction(["Texas has 163 active cars on the platform.", "", TEXAS_TABLE].join("\n")),
    ).toEqual([]);
  });

  it("(b) a rounded total within tolerance of the sum", () => {
    expect(
      selfContradiction(["Texas has 165 active cars on the platform.", "", TEXAS_TABLE].join("\n")),
    ).toEqual([]);
  });

  it("(b) an approximated total gets the wider tolerance", () => {
    expect(
      selfContradiction(["Texas has ~150 active cars on the platform.", "", TEXAS_TABLE].join("\n")),
    ).toEqual([]);
  });

  it("(b) a table the copy itself calls a SELECTION is never summed", () => {
    expect(
      selfContradiction(
        [
          "Texas has 220 active cars. The top markets:",
          "",
          TEXAS_TABLE,
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("(b) a table with an 'Others' row is admitting it is a summary", () => {
    expect(
      selfContradiction(
        [
          "Texas has 220 active cars on the platform.",
          "",
          [
            "| Market | Active cars |",
            "| --- | --- |",
            "| Austin | 61 |",
            "| Dallas | 48 |",
            "| Others | 39 |",
          ].join("\n"),
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("(b) a sentence about ONE ROW is compared to that row, not to the column sum", () => {
    expect(
      selfContradiction(["Austin has 60 active cars right now.", "", TEXAS_TABLE].join("\n")),
    ).toEqual([]);
  });

  it("(b) a TIME SERIES is snapshots, not parts of a total", () => {
    expect(
      selfContradiction(
        [
          "Texas has 220 active cars on the platform.",
          "",
          [
            "| Month | Active cars |",
            "| --- | --- |",
            "| Jan | 150 |",
            "| Feb | 170 |",
            "| Mar | 220 |",
          ].join("\n"),
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("(b) a number about a DIFFERENT subject than the column", () => {
    expect(
      selfContradiction(["There are 220 bookings open this week.", "", TEXAS_TABLE].join("\n")),
    ).toEqual([]);
  });

  it("(b) a percentage column is not summable", () => {
    expect(
      selfContradiction(
        [
          "Texas has 220 active cars on the platform.",
          "",
          [
            "| Market | Active cars share |",
            "| --- | --- |",
            "| Austin | 37% |",
            "| Dallas | 29% |",
            "| Houston | 24% |",
          ].join("\n"),
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("(b) a table whose own Total row is excluded from the sum", () => {
    expect(
      selfContradiction(
        [
          "Texas has 163 active cars on the platform.",
          "",
          [
            "| Market | Active cars |",
            "| --- | --- |",
            "| Austin | 61 |",
            "| Dallas | 48 |",
            "| Houston | 39 |",
            "| San Antonio | 15 |",
            "| **Total** | **163** |",
          ].join("\n"),
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("(b) a TRUNCATED tool page means the rows are a page — never sum them (C10's reasoning, reused)", () => {
    const truncated: ToolCallLite = {
      name: "mcp__server__operator_db__query",
      status: "success",
      input: JSON.stringify({ sql: "select market, active_cars from ..." }),
      output: JSON.stringify([
        {
          type: "text",
          text: JSON.stringify({ rows: [], _truncated: true, _returned: 4, _total: 19 }),
        },
      ]),
    };
    expect(
      selfContradiction(
        ["Texas has 220 active cars on the platform.", "", TEXAS_TABLE].join("\n"),
        [truncated],
      ),
    ).toEqual([]);
  });

  it("an answer with no counts and no tables", () => {
    expect(
      selfContradiction("Meta CPM rose last month and your checkout conversion fell with it."),
    ).toEqual([]);
  });
});

describe("C11 self_contradiction — the false positives measured on 71 real report files", () => {
  it("a GROUPING list: 6 testimonials presented as two category bullets", () => {
    expect(
      selfContradiction(
        [
          "The homepage shows **6 testimonials in a launch cohort carousel**, attributed to:",
          "",
          "- **Parents:** Rahul Iyer, Pooja Gupta, Sneha Menon",
          "- **Tutors:** Meera Reddy, Karthik Menon, Priya Sharma",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a SENTENCE BOUNDARY between the count and the list — the list belongs to the later sentence", () => {
    expect(
      selfContradiction(
        [
          "Green across three layers is not the same as covered. These were not tested locally and are the highest-value next targets:",
          "",
          "- Slack surface",
          "- Cron surface",
          "- Email surface",
          "- A2A handoff",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a HEADING's count describes its section, not the list beneath it", () => {
    expect(
      selfContradiction(
        [
          "#### P-101 — Workspace shell — 4 agents missing from sidebar but actively running",
          "- **Sidebar lists 8:** chief-of-staff, qa-engineer, cto-engineer",
          "- **Home tab counter says 9 active**",
          "- **Approvals queue has decisions from 12 distinct agents**",
          "- **Settings shows no hidden agents.**",
          "- **Net:** four agents are running but invisible.",
          "- Founder cannot open a thread to any of them.",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a count behind a preposition is an instrument, not the subject of the list", () => {
    expect(
      selfContradiction(
        [
          "The risk is in what it SAYS, not in what it DOES with money. Independently verified by two lanes:",
          "",
          "- The full money path works end to end.",
          "- Fee arithmetic recomputed against all order rows.",
          "- Manual capture is real.",
          "- Deadline parity is byte-identical on both sides.",
          "- Isolation is clean.",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a PASS/FAIL tally line is not a count of the breakdown under it", () => {
    expect(
      selfContradiction(
        ["**10 PASS / 5 FAIL / 4 GAP / 1 could-not-verify** (20 cases)", "", "- P0: 0", "- P1: 6 findings", "- P2: 3", "- P3: 3"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a decimal's fraction digit is not a count ('rerank-2.5 fix is doing the work')", () => {
    expect(
      selfContradiction(
        [
          "Pass criteria: the OR-pool + rerank-2.5 fix is doing the work, not a lucky lexical hit:",
          "",
          "- top-3 for at least 2 of 3 paraphrases",
          "- retrieval_mode is rerank on the dense path",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a byte cap quoted next to a table is not a total of that table's column", () => {
    expect(
      selfContradiction(
        [
          "Note the scaffold has TWO 65536 violations (two different files each over 64KB synth-create diff).",
          "",
          [
            "| agent_run | files |",
            "| --- | --- |",
            "| `19e4882c` (scaffold) | 21 |",
            "| `ec3812c6` (build) | 16 |",
          ].join("\n"),
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("C11 self_contradiction — controls (the guard, not a dead check, is why those are clean)", () => {
  it("control for the TIME SERIES guard: the same table with market labels DOES fire", () => {
    expect(
      selfContradiction(
        [
          "Texas has 880 active cars on the platform.",
          "",
          [
            "| Market | Active cars |",
            "| --- | --- |",
            "| Austin | 150 |",
            "| Dallas | 170 |",
            "| Houston | 220 |",
          ].join("\n"),
        ].join("\n"),
      ),
    ).toHaveLength(1);
  });

  it("control for the PERCENTAGE-column guard: the same table with plain counts DOES fire", () => {
    expect(
      selfContradiction(
        [
          "Texas has 220 active cars on the platform.",
          "",
          [
            "| Market | Active cars |",
            "| --- | --- |",
            "| Austin | 37 |",
            "| Dallas | 29 |",
            "| Houston | 24 |",
          ].join("\n"),
        ].join("\n"),
      ),
    ).toHaveLength(1);
  });

  it("control for the ONE-ROW guard: the same sentence scoped to the whole table DOES fire", () => {
    expect(
      selfContradiction(["Texas has 60 active cars right now.", "", TEXAS_TABLE].join("\n")),
    ).toHaveLength(1);
  });

  it("control for the OTHERS-row guard: the same table with a named row DOES fire", () => {
    expect(
      selfContradiction(
        [
          "Texas has 220 active cars on the platform.",
          "",
          [
            "| Market | Active cars |",
            "| --- | --- |",
            "| Austin | 61 |",
            "| Dallas | 48 |",
            "| Houston | 39 |",
          ].join("\n"),
        ].join("\n"),
      ),
    ).toHaveLength(1);
  });

  it("control for the SUB-BULLET guard: the same items promoted to top level DO fire", () => {
    expect(
      selfContradiction(
        [
          "Three things drove it:",
          "",
          "- Meta CPM up 41%",
          "- Austin worst hit",
          "- Dallas next",
          "- The pricing test cut conversion",
        ].join("\n"),
      ),
    ).toHaveLength(1);
  });

  it("control for the CAVEAT-item guard: the same 4th item without the note lead-in DOES fire", () => {
    expect(
      selfContradiction(
        ["Three things drove it:", "", "- CPM", "- Conversion", "- Supply", "- Attribution is modelled."].join("\n"),
      ),
    ).toHaveLength(1);
  });

  it("control for the TRUNCATED-page guard: the same answer with an untruncated read DOES fire", () => {
    const whole: ToolCallLite = {
      name: "mcp__server__operator_db__query",
      status: "success",
      input: JSON.stringify({ sql: "select market, active_cars from ..." }),
      output: JSON.stringify([{ type: "text", text: JSON.stringify({ rows: [], _returned: 4 }) }]),
    };
    expect(
      selfContradiction(
        ["Texas has 220 active cars on the platform.", "", TEXAS_TABLE].join("\n"),
        [whole],
      ),
    ).toHaveLength(1);
  });
});

describe("C11 self_contradiction — arming", () => {
  it("OFF by default — the gate must be opted in", () => {
    const r = runGroundingChecks({
      evidence: [],
      agent_output: ["Three things drove it:", "", "- A", "- B", "- C", "- D"].join("\n"),
      agentSlug: "chief-of-staff",
    });
    expect(r.flags.find((f) => f.pattern === "self_contradiction")).toBeUndefined();
  });

  it("arms the report writers", () => {
    for (const slug of ["chief-of-staff", "pm", "operator", "growth-lead", "performance-marketer"]) {
      expect(SELF_CONTRADICTION_DOMAIN_AGENTS.has(slug)).toBe(true);
    }
  });

  it("does NOT arm broadly — engineer/qa/advisor are held back until the live FP rate is read", () => {
    for (const slug of ["engineer", "qa", "advisor"]) {
      expect(SELF_CONTRADICTION_DOMAIN_AGENTS.has(slug)).toBe(false);
    }
  });
});
