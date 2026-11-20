import { describe, it, expect } from "vitest";
import { findInternalJargon, hasInternalJargon } from "../internal-jargon";
import {
  composeCustomerStatusBody,
  projectRunStatus,
  STATUS_PHRASES,
  unionChildRuns,
  type ProjectableRun,
} from "../run-status-projection";
import { composeHandoffBody } from "../handoff-result";
import {
  isModelRefusalEnvelope,
  modelRefusalParsed,
  readCustomerFacingFields,
} from "../model-refusal-envelope";
import { deriveOutcome } from "../outcome-model";

const INCIDENT_DELIVERABLE =
  "I can't ship these PRs from this run — the sandbox is on the wrong repo. " +
  "Evidence (`git remote -v` in the sandbox): the checked-out repo is " +
  "`Praxis-build/upcarai-6ec4d609`, not the customer repo. Fix: re-dispatch the " +
  "same two-PR ask with `repo_hint: rravi149/upcar` so the sandbox clones the " +
  "right repo. No envelope emitted — this run has nothing to ship.";

const INTERNAL = [
  /sandbox/i,
  /repo_hint/i,
  /envelope/i,
  /git remote/i,
  /@engineer/i,
  /handed off from/i,
  /[0-9a-f]{8}-[0-9a-f]{4}-/i,
  /⚠/,
  /Correction/,
  /Unverified/,
];

function expectCustomerSafe(body: string) {
  for (const re of INTERNAL) expect(body).not.toMatch(re);
}

const RUN_ID = "3f1c2b7a-1111-4222-8333-944445555666";

describe("internal-jargon detector", () => {
  it("flags every term class in the incident write-up", () => {
    expect(findInternalJargon(INCIDENT_DELIVERABLE)).toEqual(
      expect.arrayContaining(["repo_hint", "envelope", "sandbox", "git_command"]),
    );
  });

  it("flags uuids, code paths, tool names and ticket keys", () => {
    expect(hasInternalJargon(`run ${RUN_ID} finished`)).toBe(true);
    expect(hasInternalJargon("I edited src/app/checkout/page.tsx")).toBe(true);
    expect(hasInternalJargon("called mcp__github__open_pr")).toBe(true);
    expect(hasInternalJargon("called praxis__handoff")).toBe(true);
    expect(hasInternalJargon("tracked in SCRUM-4121")).toBe(true);
    expect(hasInternalJargon("then git push the branch")).toBe(true);
  });

  it("FALSE POSITIVE: a normal plain deliverable passes unchanged", () => {
    const plain =
      "Your checkout page now shows the delivery fee before the last step, so " +
      "shoppers see the full price earlier. Conversion on that page was 3.1% last " +
      "week. See https://github.com/acme/shop/pull/812 and your /pricing.html page. " +
      "We sent 24/7 support hours to the footer.";
    expect(findInternalJargon(plain)).toEqual([]);
  });
});

describe("projectRunStatus", () => {
  it("INCIDENT: refused engineer with a jargon deliverable, no reason code -> server phrase only", () => {
    const outcome = deriveOutcome({
      status: "success",
      outputText: INCIDENT_DELIVERABLE,
      sideEffect: { kind: "refused", reason: "refused_envelope" },
    });
    const s = projectRunStatus({ id: RUN_ID, agent_slug: "engineer", status: "success", outcome });
    expect(s.state).toBe("done");
    expect(s.title).toBe(STATUS_PHRASES.no_change);
    expect(s.summary).toBeNull();
    const body = composeCustomerStatusBody(s);
    expect(body).toBe("No changes were made.");
    expectCustomerSafe(body);
  });

  it("INCIDENT with reason_code wrong_repo -> needs_input + the repo question", () => {
    const outcome = deriveOutcome({
      status: "success",
      outputText: INCIDENT_DELIVERABLE,
      sideEffect: { kind: "refused", reason: "refused_envelope", reason_code: "wrong_repo" },
    });
    const s = projectRunStatus({ id: RUN_ID, status: "success", outcome });
    expect(s.state).toBe("needs_input");
    expect(s.next).toBe("pick_repo");
    expect(composeCustomerStatusBody(s)).toBe(
      "I couldn't work in the right repo. Which one should I use?",
    );
  });

  it("shipped PR renders 'Opened PR #N: <title>' + the link", () => {
    const run: ProjectableRun = {
      id: RUN_ID,
      status: "success",
      outcome: deriveOutcome({
        status: "success",
        outputText: "## Plan\nEdited `src/app/page.tsx`",
        sideEffect: { kind: "shipped", detail: "d1" },
      }),
      parsed: {
        title: "Show the delivery fee earlier",
        pr_url: "https://github.com/acme/shop/pull/812",
        pr_number: 812,
      },
    };
    const s = projectRunStatus(run);
    expect(s.state).toBe("done");
    expect(s.title).toBe("Opened PR #812: Show the delivery fee earlier");
    expect(s.links).toEqual([
      { kind: "pr", url: "https://github.com/acme/shop/pull/812", label: "PR #812" },
    ]);
    expect(s.text_fallback).toBe(
      "Opened PR #812: Show the delivery fee earlier\nhttps://github.com/acme/shop/pull/812",
    );
    expect(s.summary).toBeNull();
  });

  it("never trusts a PR url on a run that did not ship (prose can type any link)", () => {
    const s = projectRunStatus({
      id: RUN_ID,
      status: "success",
      outcome: deriveOutcome({ status: "success", outputText: "answer" }),
      parsed: { pr_url: "https://github.com/acme/shop/pull/9" },
    });
    expect(s.links).toEqual([]);
    expect(s.title).not.toMatch(/Opened/);
  });

  it("parse-failed renders the couldnt phrase", () => {
    const s = projectRunStatus({
      id: RUN_ID,
      status: "parse_failed",
      outcome: deriveOutcome({ status: "parse_failed", parseError: "no <pr_proposal> block found" }),
    });
    expect(s.state).toBe("couldnt");
    expect(composeCustomerStatusBody(s)).toBe(
      "This didn't finish. Nothing was saved. I can try again.",
    );
  });

  it("a clean customer_summary is used verbatim, over the deliverable", () => {
    const summary = "Your checkout page now shows the delivery fee before the last step.";
    const outcome = deriveOutcome({
      status: "success",
      outputText: "## Files\n- `src/app/checkout/page.tsx` (modify)",
      sideEffect: { kind: "shipped", detail: "d1" },
      customerSummary: summary,
    });
    const s = projectRunStatus({ id: RUN_ID, status: "success", outcome });
    expect(s.summary).toBe(summary);
    expect(composeCustomerStatusBody(s)).toBe(`${STATUS_PHRASES.change_ready}\n\n${summary}`);
  });

  it("a customer_summary carrying jargon falls through to the phrase", () => {
    const outcome = deriveOutcome({
      status: "success",
      outputText: INCIDENT_DELIVERABLE,
      sideEffect: { kind: "refused", reason: "refused_envelope", reason_code: "blocked" },
      customerSummary: "Re-run with repo_hint set.",
    });
    const s = projectRunStatus({ id: RUN_ID, status: "success", outcome });
    expect(s.summary).toBeNull();
    expect(composeCustomerStatusBody(s)).toBe(STATUS_PHRASES.blocked);
  });

  it("working: names the repo from payload.repo_hint", () => {
    const s = projectRunStatus({ id: RUN_ID, status: "running", payload: { repo_hint: "acme/shop" } });
    expect(s).toMatchObject({ state: "working", title: "Working on it in acme/shop." });
  });

  it("children: a working child keeps the parent working and PR links roll up", () => {
    const shippedChild: ProjectableRun = {
      id: "c1",
      status: "success",
      outcome: deriveOutcome({ status: "success", outputText: "ok", sideEffect: { kind: "shipped" } }),
      parsed: { pr_url: "https://github.com/acme/shop/pull/5", pr_number: 5 },
    };
    const parent: ProjectableRun = {
      id: "p1",
      status: "success",
      outcome: deriveOutcome({ status: "success", outputText: "Here is the plan." }),
    };
    expect(projectRunStatus(parent, [shippedChild, { id: "c2", status: "running" }]).state).toBe(
      "working",
    );
    const done = projectRunStatus(parent, [shippedChild]);
    expect(done.state).toBe("done");
    expect(done.links.map((l) => l.url)).toEqual(["https://github.com/acme/shop/pull/5"]);
  });

  it("unionChildRuns dedups thread-linked and lineage-linked runs by id", () => {
    const a = [{ id: "x" }, { id: "y" }];
    const b = [{ id: "y" }, { id: "z" }];
    expect(unionChildRuns(a, b).map((r) => r.id)).toEqual(["x", "y", "z"]);
  });
});

describe("composeHandoffBody (web chat seam)", () => {
  const base = { tenant_id: "t1", run_id: RUN_ID, operator_thread_id: "th1", from_agent_slug: "engineer" };

  it("INCIDENT: no prefix, no raw specialist text, no internal terms", () => {
    const outcome = deriveOutcome({
      status: "success",
      outputText: INCIDENT_DELIVERABLE,
      sideEffect: { kind: "refused", reason: "refused_envelope" },
    });
    const body = composeHandoffBody({
      ...base,
      status: "success",
      output_text: INCIDENT_DELIVERABLE,
      raw_response_text: INCIDENT_DELIVERABLE,
      outcome,
    });
    expect(body).toBe(STATUS_PHRASES.no_change);
    expectCustomerSafe(body);
  });

  it("shipped PR: the structured link backs the 'Opened PR' line (no hedge banner)", () => {
    const body = composeHandoffBody({
      ...base,
      status: "success",
      output_text: "done",
      outcome: deriveOutcome({ status: "success", outputText: "done", sideEffect: { kind: "shipped" } }),
      parsed: { title: "Fix the footer", pr_url: "https://github.com/acme/shop/pull/7", pr_number: 7 },
    });
    expect(body.startsWith("Opened PR #7: Fix the footer\nhttps://github.com/acme/shop/pull/7")).toBe(true);
    expectCustomerSafe(body);
  });

  it("parse-failed: the couldnt phrase leads; raw_response_text never appears", () => {
    const body = composeHandoffBody({
      ...base,
      status: "failed",
      parse_failed: true,
      output_text: "",
      raw_response_text: "raw model text with `src/x.ts`",
      error: "no <pr_proposal> block found",
    });
    expect(body).toBe(STATUS_PHRASES.couldnt);
  });

  it("a plain answer from an answering specialist still reaches the customer", () => {
    const answer = "You spent $412 on ads last week, down 8% from the week before.";
    const body = composeHandoffBody({ ...base, from_agent_slug: "meta_ads", status: "success", output_text: answer });
    expect(body).toBe(answer);
  });
});

describe("answer-only run: the answer is the whole body", () => {
  const answer = "I couldn't do either part: the page would not load.";
  const answerRun: ProjectableRun = { id: "r-ans", agent_slug: "seo-geo", status: "success", output_text: answer };

  it("keeps Answered. as the record's title but never shows it above the answer", () => {
    const s = projectRunStatus(answerRun);
    expect(s.title).toBe("Answered.");
    expect(s.text_fallback).toBe("Answered.");
    expect(composeCustomerStatusBody(s)).toBe(answer);
  });

  it("a run with no answer keeps its status line alone", () => {
    const s = projectRunStatus({ id: "r-empty", agent_slug: "seo-geo", status: "success", output_text: "" });
    expect(s.title).toBe("Finished.");
    expect(s.summary).toBeNull();
    expect(composeCustomerStatusBody(s)).toBe("Finished.");
  });

  it("an answer made only of internal vocabulary falls back to Finished., never an empty body", () => {
    const body = composeCustomerStatusBody(
      projectRunStatus({ ...answerRun, output_text: "See the sandbox log." }),
    );
    expect(body).toBe("Finished.");
  });

  it("an answer that is literally the phrase does not vanish or double", () => {
    const body = composeCustomerStatusBody(projectRunStatus({ ...answerRun, output_text: "Answered." }));
    expect(body).toBe("Answered.");
  });

  it("drops the line when customer_summary and the deliverable differ, showing the summary", () => {
    const body = composeCustomerStatusBody(
      projectRunStatus({
        ...answerRun,
        output_text: null,
        outcome: { customer_summary: "Short answer.", deliverable: "Long answer." },
      }),
    );
    expect(body).toBe("Short answer.");
  });

  it("a failed run that still left a clean answer shows only that answer", () => {
    const body = composeCustomerStatusBody(
      projectRunStatus({
        id: "r-f",
        status: "failed",
        outcome: { deliverable: answer, failure: { class: "none" } as never },
      }),
    );
    expect(body).toBe(answer);
  });

  it("a PR a child opened survives under the answer with no status line", () => {
    const pr = "https://github.com/acme/app/pull/12";
    const child: ProjectableRun = {
      id: "c1",
      status: "success",
      outcome: { side_effect: { kind: "shipped" } as never },
      parsed: { pr_url: pr },
    };
    const s = projectRunStatus(answerRun, [child]);
    expect(s.title).toBe("Answered.");
    expect(composeCustomerStatusBody(s)).toBe(`${answer}\n${pr}`);
  });

  it("a child still working holds the answer back and says so", () => {
    const body = composeCustomerStatusBody(projectRunStatus(answerRun, [{ id: "c1", status: "running" }]));
    expect(body).toBe(STATUS_PHRASES.working);
    expect(body).not.toContain(answer);
  });
});

describe("status lines that carry real information stay with the answer", () => {
  const answer = "Here is what I found on your site.";
  const shipped = { side_effect: { kind: "shipped" } as never, deliverable: answer };

  it.each([
    ["no_change leads then states it", { status: "success", outcome: { side_effect: { kind: "refused", reason_code: "no_change" } as never, deliverable: answer } }, `${answer}\n\n${STATUS_PHRASES.no_change}`],
    ["refused with no reason", { status: "success", outcome: { side_effect: { kind: "refused" } as never, deliverable: answer } }, `${STATUS_PHRASES.no_change}\n\n${answer}`],
    ["blocked", { status: "success", outcome: { side_effect: { kind: "refused", reason_code: "blocked" } as never, deliverable: answer } }, `${STATUS_PHRASES.blocked}\n\n${answer}`],
    ["needs_input", { status: "success", outcome: { side_effect: { kind: "refused", reason_code: "needs_input" } as never, deliverable: answer } }, `${STATUS_PHRASES.needs_input}\n\n${answer}`],
    ["wrong_repo", { status: "success", outcome: { side_effect: { kind: "refused", reason_code: "wrong_repo" } as never, deliverable: answer } }, `${STATUS_PHRASES.wrong_repo}\n\n${answer}`],
    ["shipped by a non-channel agent", { agent_slug: "engineer", status: "success", outcome: shipped }, `${STATUS_PHRASES.change_ready}\n\n${answer}`],
    ["did not finish", { status: "failed", outcome: { deliverable: answer } }, `${STATUS_PHRASES.couldnt}\n\n${answer}`],
  ] as const)("%s", (_name, run, expected) => {
    expect(composeCustomerStatusBody(projectRunStatus({ id: "r", ...run } as ProjectableRun))).toBe(expected);
  });

  it("a channel specialist's filed steps keep the line saying where they went", () => {
    const s = projectRunStatus({ id: "r", agent_slug: "meta_ads", status: "success", outcome: shipped });
    expect(composeCustomerStatusBody(s)).toBe(`${answer}\n\n${s.title}`);
    expect(s.title).toMatch(/next steps to your .* channel/);
  });

  it("a PR the run opened keeps its line and link above the answer", () => {
    const pr = "https://github.com/acme/app/pull/7";
    const s = projectRunStatus({ id: "r", status: "success", outcome: shipped, parsed: { pr_url: pr } });
    expect(composeCustomerStatusBody(s)).toBe(`Opened PR #7\n${pr}\n\n${answer}`);
  });
});

describe("no_change: the answer leads", () => {
  it("a declared no_change refusal projects done, summary first", () => {
    const run: ProjectableRun = {
      id: "r1",
      agent_slug: "engineer",
      status: "success",
      outcome: {
        deliverable: "Checked every table.",
        side_effect: { kind: "refused", reason: "refused_envelope", reason_code: "no_change" },
        customer_summary: "RLS is already on for every table.",
      },
    };
    const s = projectRunStatus(run);
    expect(s.state).toBe("done");
    expect(s.title).toBe(STATUS_PHRASES.no_change);
    expect(s.summary_first).toBe(true);
    expect(composeCustomerStatusBody(s)).toBe(`RLS is already on for every table.\n\n${STATUS_PHRASES.no_change}`);
  });

  it("a refusal with no declared reason keeps the status line first", () => {
    const s = projectRunStatus({
      id: "r2",
      status: "success",
      outcome: { deliverable: "Held for review.", side_effect: { kind: "refused", reason: "critic_fail" } },
    });
    expect(s.summary_first).toBeUndefined();
    expect(composeCustomerStatusBody(s)).toBe(`${STATUS_PHRASES.no_change}\n\nHeld for review.`);
  });
});

describe("a channel specialist that filed steps", () => {
  const answer = "I can't give you three verified fixes yet. Add your site in Settings and I'll rerun the audit.";
  const filed = deriveOutcome({ status: "success", outputText: answer, sideEffect: { kind: "shipped", detail: "a1,a2" } });

  it("leads with the answer and says the steps were added to that channel, not that something changed", () => {
    const s = projectRunStatus({ id: RUN_ID, agent_slug: "seo", status: "success", outcome: filed });
    expect(s.state).toBe("done");
    expect(s.title).toBe("I added the next steps to your SEO channel in Zavi.");
    const body = composeCustomerStatusBody(s);
    expect(body).toBe(`${answer}\n\nI added the next steps to your SEO channel in Zavi.`);
    expect(body).not.toContain(STATUS_PHRASES.change_ready);
  });

  it("keeps 'The change is ready.' for the engineer, whose shipped run prepared a real change", () => {
    const s = projectRunStatus({ id: RUN_ID, agent_slug: "engineer", status: "success", outcome: filed });
    expect(s.title).toBe(STATUS_PHRASES.change_ready);
    expect(composeCustomerStatusBody(s)).toBe(`${STATUS_PHRASES.change_ready}\n\n${answer}`);
  });
});

describe("refusal envelope + customer-facing fields", () => {
  it("accepts a declared refusal and keeps reason_code + customer_summary", () => {
    const inner = {
      refused: true,
      reason_code: "wrong_repo",
      customer_summary: "I need to know which of your repos to change.",
      rendered_markdown: "details",
    };
    expect(isModelRefusalEnvelope(inner)).toBe(true);
    expect(modelRefusalParsed(inner)).toEqual({
      rendered_markdown: "details",
      refused: true,
      parse_fallback_kind: "model_refusal",
      reason_code: "wrong_repo",
      customer_summary: "I need to know which of your repos to change.",
    });
  });

  it("rejects non-refusals and drops an unknown reason code", () => {
    expect(isModelRefusalEnvelope({ repo: "a/b", title: "x" })).toBe(false);
    expect(isModelRefusalEnvelope({ refused: true })).toBe(false);
    expect(modelRefusalParsed({ refused: true, reason_code: "nope", rendered_markdown: "x" })).not.toHaveProperty(
      "reason_code",
    );
  });

  it("readCustomerFacingFields reads only well-formed values", () => {
    expect(readCustomerFacingFields({ customer_summary: "  Done.  ", reason_code: "no_change" })).toEqual({
      customer_summary: "Done.",
      reason_code: "no_change",
    });
    expect(readCustomerFacingFields({ customer_summary: 5, reason_code: "other" })).toEqual({});
    expect(readCustomerFacingFields(null)).toEqual({});
  });
});
