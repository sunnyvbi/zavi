import { describe, it, expect, vi } from "vitest";
import {
  isStatusOrProvenanceQuestion,
  projectPrLiveState,
  buildLiveStateAnswer,
  answerNonPushFollowup,
  type NonPushAnswerDeps,
  type PrLiveState,
} from "../pr-nonpush-answer";
import type { OpenEngineerPr } from "../chat-pr-followup";

const pr = (n: number, extra: Partial<OpenEngineerPr> = {}): OpenEngineerPr => ({
  decision_id: `dec-${n}`,
  run_id: `run-${n}`,
  pr_number: n,
  pr_repo: "rravi149/praxis",
  pr_url: `https://github.com/rravi149/praxis/pull/${n}`,
  head_branch: `engineer/${n}`,
  ...extra,
});

describe("isStatusOrProvenanceQuestion", () => {
  it("matches the 2026-07-10 incident provenance question", () => {
    expect(
      isStatusOrProvenanceQuestion("is this issue fixed by some other agent already or not?"),
    ).toBe(true);
  });

  it("matches common status questions", () => {
    for (const q of [
      "is this fixed?",
      "did it merge?",
      "has this been shipped",
      "what's the status of the PRs?",
      "who fixed this?",
      "is it already done?",
      "@Zavi is this merged yet?",
    ]) {
      expect(isStatusOrProvenanceQuestion(q), q).toBe(true);
    }
  });

  it("does NOT match change-shaped / open-ended non-push turns", () => {
    for (const q of [
      "also use blue instead",
      "rename the button to Save",
      "dig deeper on the root cause, this fix looks incomplete",
      "add a test for the edge case",
      "",
    ]) {
      expect(isStatusOrProvenanceQuestion(q), q).toBe(false);
    }
  });
});

describe("projectPrLiveState", () => {
  it("reports a merged PR as merged (never falsely open) and reconciles each PR", async () => {
    const deps: NonPushAnswerDeps = {
      resolveInstallationId: async () => 123,
      getPr: async (_t, _i, a) =>
        a.pull_number === 1763
          ? { state: "closed", merged: true }
          : { state: "open", merged: false },
    };
    const out = await projectPrLiveState("t1", [pr(1770), pr(1763)], deps);
    expect(out.find((p) => p.pr_number === 1763)).toMatchObject({ state: "closed", merged: true });
    expect(out.find((p) => p.pr_number === 1770)).toMatchObject({ state: "open", merged: false });
  });

  it("marks state 'unknown' on a get_pr failure — never asserts open", async () => {
    const deps: NonPushAnswerDeps = {
      resolveInstallationId: async () => 123,
      getPr: async () => {
        throw new Error("get_pr HTTP 404");
      },
    };
    const out = await projectPrLiveState("t1", [pr(1770)], deps);
    expect(out[0]).toMatchObject({ state: "unknown", merged: false });
  });

  it("marks unknown when the installation cannot be resolved", async () => {
    const deps: NonPushAnswerDeps = {
      resolveInstallationId: async () => {
        throw new Error("no installation");
      },
      getPr: async () => ({ state: "open", merged: false }),
    };
    const out = await projectPrLiveState("t1", [pr(1770)], deps);
    expect(out[0].state).toBe("unknown");
  });
});

describe("buildLiveStateAnswer (deterministic fallback)", () => {
  it("names merged as merged, open as open, and anchors provenance to this agent", () => {
    const ans = buildLiveStateAnswer([
      { pr_number: 1770, pr_repo: "rravi149/praxis", pr_url: "u1770", state: "open", merged: false },
      { pr_number: 1763, pr_repo: "rravi149/praxis", pr_url: "u1763", state: "closed", merged: true },
    ]);
    expect(ans).toMatch(/not another agent/i);
    expect(ans).toMatch(/open.*#1770/i);
    expect(ans).toMatch(/merged.*#1763/i);
    expect(ans).not.toMatch(/open:[^.]*#1763/i);
  });
});

describe("answerNonPushFollowup (orchestrator)", () => {
  const liveDeps = (): NonPushAnswerDeps => ({
    resolveInstallationId: async () => 123,
    getPr: async (_t, _i, a) =>
      a.pull_number === 1763
        ? { state: "closed", merged: true }
        : { state: "open", merged: false },
  });

  it("returns null (→ real engineer) for a non-status turn, never composing", async () => {
    const compose = vi.fn(async () => "should not be called");
    const out = await answerNonPushFollowup(
      { tenant_id: "t1", text: "also use blue instead", prs: [pr(1770)] },
      { ...liveDeps(), composeAnswer: compose },
    );
    expect(out).toBeNull();
    expect(compose).not.toHaveBeenCalled();
  });

  it("answers a provenance question from LIVE state via the composer", async () => {
    const compose = vi.fn(async (_q: string, projected: PrLiveState[]) => {
      const merged = projected.find((p) => p.merged);
      return `Mine, not another agent. #1770 open; #${merged?.pr_number} merged.`;
    });
    const out = await answerNonPushFollowup(
      {
        tenant_id: "t1",
        text: "is this issue fixed by some other agent already or not?",
        prs: [pr(1770), pr(1763)],
      },
      { ...liveDeps(), composeAnswer: compose },
    );
    expect(compose).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/#1763 merged/);
    expect(out).toMatch(/not another agent/i);
  });

  it("falls back to the deterministic answer when the composer throws", async () => {
    const out = await answerNonPushFollowup(
      { tenant_id: "t1", text: "is this fixed?", prs: [pr(1770), pr(1763)] },
      {
        ...liveDeps(),
        composeAnswer: async () => {
          throw new Error("LLM timeout");
        },
      },
    );
    expect(out).toMatch(/merged.*#1763/i);
    expect(out).toMatch(/open.*#1770/i);
  });
});
