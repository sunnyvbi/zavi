import { describe, it, expect } from "vitest";
import {
  extractChatThreadId,
  extractSlackRouting,
  buildOpenPrNotice,
  buildVerifyStatusLine,
  buildDispatchNotice,
  partialReportIsComplete,
  renderPartialReport,
  type OpenPrNoticeResult,
  type PartialReport,
} from "./dispatch-notice";

it("explains missing Composio inputs without offering approval or an identical retry", () => {
  const notice = buildDispatchNotice({
    handler: "composio.execute_tool",
    ok: false,
    error: "Tiktok Ads refused: Invalid request data provided - Following fields are missing: {'asset_type', 'asset_ids'}",
  });
  expect(notice).toContain("Correct the required inputs");
  expect(notice).not.toContain("tell me to retry");
  expect(notice).not.toContain("open the card in Zavi");
});

describe("extractSlackRouting", () => {
  it("returns the routing for a slack run with channel + thread", () => {
    expect(
      extractSlackRouting({
        trigger: "slack",
        payload: { slack: { channel_id: "C0944L5HSBV", thread_ts: "1781072296.246929", team_id: "T0AAA" } },
      }),
    ).toEqual({ channel_id: "C0944L5HSBV", thread_ts: "1781072296.246929", team_id: "T0AAA" });
  });

  it("omits team_id when absent or empty (single-workspace tenant)", () => {
    expect(
      extractSlackRouting({
        trigger: "slack",
        payload: { slack: { channel_id: "C1", thread_ts: "1.2", team_id: "" } },
      }),
    ).toEqual({ channel_id: "C1", thread_ts: "1.2", team_id: undefined });
  });

  it("returns null for a chat run even if a slack-shaped payload is present", () => {
    expect(
      extractSlackRouting({
        trigger: "chat",
        payload: { slack: { channel_id: "C1", thread_ts: "1.2" } },
      }),
    ).toBeNull();
  });

  it("returns null when channel_id or thread_ts is missing (no bare-channel posts)", () => {
    expect(
      extractSlackRouting({ trigger: "slack", payload: { slack: { channel_id: "C1" } } }),
    ).toBeNull();
    expect(
      extractSlackRouting({ trigger: "slack", payload: { slack: { thread_ts: "1.2" } } }),
    ).toBeNull();
  });

  it("returns null for cron/null rows", () => {
    expect(extractSlackRouting({ trigger: "cron", payload: {} })).toBeNull();
    expect(extractSlackRouting(null)).toBeNull();
  });

  it("returns null when payload.slack values are non-strings", () => {
    expect(
      extractSlackRouting({ trigger: "slack", payload: { slack: { channel_id: 7, thread_ts: 1.2 } } }),
    ).toBeNull();
  });
});

describe("extractChatThreadId", () => {
  it("returns the thread_id for a chat run", () => {
    expect(
      extractChatThreadId({
        trigger: "chat",
        payload: { thread_id: "adeeea22-1631-48fa-a1af-7326925b2674" },
      }),
    ).toBe("adeeea22-1631-48fa-a1af-7326925b2674");
  });

  it("returns null for a slack run (no thread_id in payload)", () => {
    expect(
      extractChatThreadId({ trigger: "slack", payload: { slack: {}, user_id: "U1" } }),
    ).toBeNull();
  });

  it("returns null for a cron run with empty payload", () => {
    expect(extractChatThreadId({ trigger: "cron", payload: {} })).toBeNull();
  });

  it("returns null for a null run row", () => {
    expect(extractChatThreadId(null)).toBeNull();
  });

  it("returns null when thread_id is an empty string", () => {
    expect(extractChatThreadId({ trigger: "chat", payload: { thread_id: "" } })).toBeNull();
  });

  it("returns null when the trigger is non-chat even if a thread_id is present", () => {
    expect(
      extractChatThreadId({ trigger: "slack", payload: { thread_id: "1716000000.0001" } }),
    ).toBeNull();
  });

  it("returns the inherited thread_id for an a2a run (visibility fix)", () => {
    expect(
      extractChatThreadId({
        trigger: "a2a",
        payload: { thread_id: "adeeea22-1631-48fa-a1af-7326925b2674" },
      }),
    ).toBe("adeeea22-1631-48fa-a1af-7326925b2674");
  });

  it("returns null for an a2a run with no inherited thread_id (cron-origin dispatch)", () => {
    expect(extractChatThreadId({ trigger: "a2a", payload: { source_agent: "pm" } })).toBeNull();
  });

  it("returns null for an a2a run with an empty-string thread_id", () => {
    expect(extractChatThreadId({ trigger: "a2a", payload: { thread_id: "" } })).toBeNull();
  });

  it("a handoff run resolves to payload.operator_thread_id", () => {
    expect(extractChatThreadId({ trigger: "handoff", payload: { operator_thread_id: "th-op" } })).toBe("th-op");
  });

  it("a handoff run prefers thread_id over operator_thread_id, as approvals/list does", () => {
    expect(
      extractChatThreadId({ trigger: "handoff", payload: { thread_id: "th-own", operator_thread_id: "th-op" } }),
    ).toBe("th-own");
  });

  it("a handoff run falls back to operator_thread_id when thread_id is empty or not a string", () => {
    expect(extractChatThreadId({ trigger: "handoff", payload: { thread_id: "", operator_thread_id: "th-op" } })).toBe("th-op");
    expect(extractChatThreadId({ trigger: "handoff", payload: { thread_id: 7, operator_thread_id: "th-op" } })).toBe("th-op");
  });

  it("a handoff run with neither field, a null payload or a non-string id returns null", () => {
    expect(extractChatThreadId({ trigger: "handoff", payload: {} })).toBeNull();
    expect(extractChatThreadId({ trigger: "handoff", payload: null })).toBeNull();
    expect(extractChatThreadId({ trigger: "handoff", payload: { operator_thread_id: "" } })).toBeNull();
    expect(extractChatThreadId({ trigger: "handoff", payload: { operator_thread_id: { id: "x" } } })).toBeNull();
  });

  it("operator_thread_id is read on handoff runs only, never on chat, a2a or slack runs", () => {
    for (const trigger of ["chat", "a2a", "slack", "cron"]) {
      expect(extractChatThreadId({ trigger, payload: { operator_thread_id: "th-op" } })).toBeNull();
    }
  });
});

describe("buildOpenPrNotice", () => {
  const opts = {
    repo: "rravi149/upcar",
    title: "fix(users.model): relax adminNotes.addedBy",
    head_branch: "engineer/fix-adminnotes-addedby-validation",
  };

  it("a single opened PR → links the PR with repo#number, title, and branch arrow", () => {
    const results: OpenPrNoticeResult[] = [
      { base: "development", ok: true, pr_url: "https://github.com/rravi149/upcar/pull/1005", pr_number: 1005 },
    ];
    const msg = buildOpenPrNotice(results, opts);
    expect(msg).toContain("https://github.com/rravi149/upcar/pull/1005");
    expect(msg).toContain("rravi149/upcar#1005");
    expect(msg).toContain(opts.title);
    expect(msg).toContain("development");
    expect(msg).toContain(opts.head_branch);
  });

  it("a single already-open PR (ok, no url) → says already open, no broken link", () => {
    const results: OpenPrNoticeResult[] = [{ base: "development", ok: true, error: "already_open" }];
    const msg = buildOpenPrNotice(results, opts);
    expect(msg.toLowerCase()).toContain("already open");
    expect(msg).not.toContain("](undefined)");
    expect(msg).not.toContain("]()");
  });

  it("two opened PRs → enumerates both urls", () => {
    const results: OpenPrNoticeResult[] = [
      { base: "development", ok: true, pr_url: "https://github.com/o/r/pull/1", pr_number: 1 },
      { base: "main", ok: true, pr_url: "https://github.com/o/r/pull/2", pr_number: 2 },
    ];
    const msg = buildOpenPrNotice(results, opts);
    expect(msg).toContain("2 PR");
    expect(msg).toContain("https://github.com/o/r/pull/1");
    expect(msg).toContain("https://github.com/o/r/pull/2");
  });

  it("partial (one opened, one failed) → shows the opened url AND names the failed base", () => {
    const results: OpenPrNoticeResult[] = [
      { base: "development", ok: true, pr_url: "https://github.com/o/r/pull/9", pr_number: 9 },
      { base: "release/2.0", ok: false, error: "merge conflict in foo.ts" },
    ];
    const msg = buildOpenPrNotice(results, opts);
    expect(msg).toContain("https://github.com/o/r/pull/9");
    expect(msg).toContain("release/2.0");
  });

  it("supersededPrNumber → prefixes 'PR #N was already merged' on the single-PR happy path", () => {
    const results: OpenPrNoticeResult[] = [
      { base: "main", ok: true, pr_url: "https://github.com/o/r/pull/12", pr_number: 12 },
    ];
    const msg = buildOpenPrNotice(results, { ...opts, supersededPrNumber: 285 });
    expect(msg).toContain("PR #285 is no longer open for follow-up");
    expect(msg).toContain("https://github.com/o/r/pull/12");
  });

  it("no supersededPrNumber → notice byte-identical to before (no prefix)", () => {
    const results: OpenPrNoticeResult[] = [
      { base: "main", ok: true, pr_url: "https://github.com/o/r/pull/12", pr_number: 12 },
    ];
    expect(buildOpenPrNotice(results, opts)).not.toContain("no longer open for follow-up");
  });

  const single: OpenPrNoticeResult[] = [
    { base: "main", ok: true, pr_url: "https://github.com/o/r/pull/12", pr_number: 12 },
  ];

  it("PR line is NEUTRAL (📬, not ✅) — the ✅ never rides the PR line", () => {
    const msg = buildOpenPrNotice(single, opts);
    expect(msg).toContain("📬 Opened");
    expect(msg).not.toContain("✅");
  });

  it("verify=passed → appends '✅ tests passed' as a SEPARATE line; PR line still neutral", () => {
    const msg = buildOpenPrNotice(single, { ...opts, verify: { status: "passed" } });
    expect(msg).toContain("📬 Opened");
    expect(msg).toContain("✅ tests passed");
    expect(msg).not.toContain("✅ Opened");
  });

  it("verify=couldnt_run → plain 'couldn't run' + check your CI; no ⚠, no 'sandbox'; NEVER a ✅; PR still shipped", () => {
    const msg = buildOpenPrNotice(single, {
      ...opts,
      verify: { status: "couldnt_run", reason: "mongodb-memory-server download failed" },
    });
    expect(msg).toContain("📬 Opened");
    expect(msg).toContain("Tests couldn't run here");
    expect(msg).toContain("Check them in your CI");
    expect(msg).toContain("mongodb-memory-server");
    expect(msg).not.toContain("✅");
    expect(msg).not.toContain("⚠");
    expect(msg).not.toMatch(/sandbox/i);
  });

  it("verify=couldnt_run with an internal-jargon reason → the reason is dropped", () => {
    const msg = buildOpenPrNotice(single, {
      ...opts,
      verify: { status: "couldnt_run", reason: "sandbox exited before run_tests" },
    });
    expect(msg).toContain("Tests couldn't run here. Check them in your CI or locally.");
    expect(msg).not.toMatch(/sandbox/i);
  });

  it("verify=failed → plain 'Tests failed. See the PR.'; no ⚠; NEVER a ✅; PR still shipped", () => {
    const msg = buildOpenPrNotice(single, { ...opts, verify: { status: "failed" } });
    expect(msg).toContain("📬 Opened");
    expect(msg).toContain("Tests failed. See the PR.");
    expect(msg).not.toContain("⚠");
    expect(msg).not.toContain("✅");
  });

  it("verify=not_run → 🟡 tests not run; NEVER a ✅", () => {
    const msg = buildOpenPrNotice(single, { ...opts, verify: { status: "not_run" } });
    expect(msg).toContain("🟡 tests not run");
    expect(msg).not.toContain("✅");
  });

  it("verify omitted → no status line at all (still no false ✅)", () => {
    const msg = buildOpenPrNotice(single, opts);
    expect(msg).not.toContain("tests passed");
    expect(msg).not.toContain("tests not run");
  });

  it("fan-out (2 PRs) with verify=passed → status line appended once, PR lines neutral", () => {
    const results: OpenPrNoticeResult[] = [
      { base: "development", ok: true, pr_url: "https://github.com/o/r/pull/1", pr_number: 1 },
      { base: "main", ok: true, pr_url: "https://github.com/o/r/pull/2", pr_number: 2 },
    ];
    const msg = buildOpenPrNotice(results, { ...opts, verify: { status: "passed" } });
    expect(msg).toContain("📬 Opened 2 PR");
    expect(msg).toContain("✅ tests passed");
    expect(msg.match(/✅ tests passed/g)?.length).toBe(1);
  });
});

describe("buildVerifyStatusLine", () => {
  it("undefined verify → empty string (no status line)", () => {
    expect(buildVerifyStatusLine(undefined)).toBe("");
  });
  it("passed → ✅ tests passed", () => {
    expect(buildVerifyStatusLine({ status: "passed" })).toBe("✅ tests passed");
  });
  it("couldnt_run w/ reason → plain line + reason + check your CI (no ⚠)", () => {
    const s = buildVerifyStatusLine({ status: "couldnt_run", reason: "glibc mismatch" });
    expect(s).not.toContain("⚠");
    expect(s).toContain("glibc mismatch");
    expect(s).toContain("Check them in your CI");
    expect(s).not.toContain("✅");
  });
  it("failed / not_run never carry ✅", () => {
    expect(buildVerifyStatusLine({ status: "failed" })).not.toContain("✅");
    expect(buildVerifyStatusLine({ status: "not_run" })).not.toContain("✅");
  });
});

describe("buildDispatchNotice", () => {
  it("ok + handler-supplied notice → returns the notice verbatim", () => {
    expect(
      buildDispatchNotice({ handler: "github.open_pr", ok: true, notice: "✅ Opened PR #1005" }),
    ).toBe("✅ Opened PR #1005");
  });

  it("ok + no notice → a clean generic success", () => {
    const msg = buildDispatchNotice({ handler: "jira.add_comment", ok: true });
    expect(msg).toContain("✅");
    expect(msg.toLowerCase()).toContain("done");
  });

  it("failure on a known handler → reads 'Couldn't open the pull request' + the error + a recovery hint", () => {
    const msg = buildDispatchNotice({
      handler: "github.open_pr",
      ok: false,
      error: "branch protection blocked the push",
    });
    expect(msg).not.toContain("⚠");
    expect(msg.startsWith("Couldn't open the pull request")).toBe(true);
    expect(msg).toContain("branch protection blocked the push");
    expect(msg).toContain("tell me to retry, or open the card in Zavi.");
    expect(msg).not.toContain("/approvals");
  });

  it("failure on an unknown handler → falls back to a generic action phrase", () => {
    const msg = buildDispatchNotice({ handler: "some.unmapped", ok: false, error: "boom" });
    expect(msg.toLowerCase()).toContain("couldn't");
    expect(msg).toContain("boom");
  });

  it("failure with a huge error → truncates so the bubble stays readable", () => {
    const huge = "x".repeat(5000);
    const msg = buildDispatchNotice({ handler: "github.open_pr", ok: false, error: huge });
    expect(msg.length).toBeLessThan(700);
  });
});

describe("partialReportIsComplete — complete-success short-circuit", () => {
  it("undefined → true (no report = nothing to flag)", () => {
    expect(partialReportIsComplete(undefined)).toBe(true);
  });

  it("clean full success → true", () => {
    const p: PartialReport = {
      attempted: 5, total: 5, succeeded: 4, already_done: 1, failed: 0,
    };
    expect(partialReportIsComplete(p)).toBe(true);
  });

  it("attempted < total (silently dropped items) → false", () => {
    const p: PartialReport = {
      attempted: 37, total: 43, succeeded: 37, already_done: 0, failed: 0,
    };
    expect(partialReportIsComplete(p)).toBe(false);
  });

  it("any failure → false (even when total matches)", () => {
    const p: PartialReport = {
      attempted: 5, total: 5, succeeded: 4, already_done: 0, failed: 1,
    };
    expect(partialReportIsComplete(p)).toBe(false);
  });

  it("attempted = total but succeeded + already_done < total → false (count mismatch)", () => {
    const p: PartialReport = {
      attempted: 5, total: 5, succeeded: 3, already_done: 1, failed: 0,
    };
    expect(partialReportIsComplete(p)).toBe(false);
  });

  it("missing[] non-empty → false even with otherwise-clean counts", () => {
    const p: PartialReport = {
      attempted: 5, total: 5, succeeded: 5, already_done: 0, failed: 0,
      missing: ["foo"],
    };
    expect(partialReportIsComplete(p)).toBe(false);
  });
});

describe("renderPartialReport — honest breakdown", () => {
  it("renders the headline counts when attempted = total", () => {
    const out = renderPartialReport({
      attempted: 5, total: 5, succeeded: 4, already_done: 0, failed: 1,
    });
    expect(out).toContain("Ran 5 of 5");
    expect(out).toContain("4 succeeded");
    expect(out).toContain("1 failed");
  });

  it("flags not-attempted explicitly when attempted < total", () => {
    const out = renderPartialReport({
      attempted: 37, total: 43, succeeded: 37, already_done: 0, failed: 0,
    });
    expect(out).toContain("Ran 37 of 43");
    expect(out).toContain("6 not attempted");
  });

  it("caps missing[] at 8 with '+N more' so chat bubbles stay bounded", () => {
    const missing = Array.from({ length: 15 }, (_, i) => `item-${i + 1}`);
    const out = renderPartialReport({
      attempted: 0, total: 15, succeeded: 0, already_done: 0, failed: 0,
      missing,
    });
    expect(out).toContain("item-1");
    expect(out).toContain("item-8");
    expect(out).not.toContain("item-9");
    expect(out).toContain("+7 more");
  });
});

describe("buildDispatchNotice — Manus #9 honest-partial guard", () => {
  it("ok + no partial_report + no notice → '✅ Done.' (unchanged behavior)", () => {
    const msg = buildDispatchNotice({ handler: "praxis.bake_rule", ok: true });
    expect(msg).toBe("✅ Done.");
  });

  it("ok + complete partial_report + no notice → '✅ Done.' (full success short-circuit)", () => {
    const msg = buildDispatchNotice({
      handler: "praxis.bake_rule", ok: true,
      partial_report: { attempted: 5, total: 5, succeeded: 5, already_done: 0, failed: 0 },
    });
    expect(msg).toBe("✅ Done.");
  });

  it("ok + NON-complete partial_report + no notice → breakdown, NEVER bare 'Done'", () => {
    const msg = buildDispatchNotice({
      handler: "praxis.bake_rule", ok: true,
      partial_report: {
        attempted: 37, total: 43, succeeded: 37, already_done: 0, failed: 0,
        missing: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
      },
    });
    expect(msg).toContain("Ran 37 of 43");
    expect(msg).toContain("6 not attempted");
    expect(msg).toContain("Missing:");
    expect(msg).toContain("alpha");
    expect(msg.trim()).not.toBe("✅ Done.");
  });

  it("ok + NON-complete partial_report + rich notice → breakdown PREPENDED to notice", () => {
    const richNotice = "✅ Opened [praxis#999](https://example/pr/999)";
    const msg = buildDispatchNotice({
      handler: "github.open_pr", ok: true,
      notice: richNotice,
      partial_report: {
        attempted: 2, total: 3, succeeded: 1, already_done: 0, failed: 1,
      },
    });
    expect(msg).toContain("Ran 2 of 3");
    expect(msg).toContain("1 failed");
    expect(msg).toContain(richNotice);
    expect(msg.indexOf("Ran 2 of 3")).toBeLessThan(msg.indexOf(richNotice));
  });

  it("failure path is untouched by partial_report (failures use the existing recovery message)", () => {
    const msg = buildDispatchNotice({
      handler: "github.open_pr", ok: false, error: "boom",
      partial_report: { attempted: 5, total: 5, succeeded: 5, already_done: 0, failed: 0 },
    });
    expect(msg.toLowerCase()).toContain("couldn't");
    expect(msg).toContain("boom");
  });
});
