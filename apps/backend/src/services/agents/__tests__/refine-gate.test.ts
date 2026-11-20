
import { describe, it, expect, vi, type Mock } from "vitest";
import {
  runRefineGate,
  computeGateVerdict,
  parsePreviewSmokeVerdict,
  gateLabel,
  renderGateEvidenceMarkdown,
  GATE_LABEL_PASS,
  GATE_LABEL_FAIL,
  type RefineGateIo,
  type GateEvidence,
} from "@/services/agents/refine-gate";

describe("parsePreviewSmokeVerdict", () => {
  it("parses an explicit pass", () => {
    const r = parsePreviewSmokeVerdict('<preview_smoke>{"verdict":"pass","evidence_md":"looks good"}</preview_smoke>');
    expect(r.verdict).toBe("pass");
    expect(r.evidence_md).toBe("looks good");
  });
  it("parses an explicit fail", () => {
    expect(parsePreviewSmokeVerdict('<preview_smoke>{"verdict":"fail"}</preview_smoke>').verdict).toBe("fail");
  });
  it("skips on absent block", () => {
    expect(parsePreviewSmokeVerdict("some prose no block").verdict).toBe("skipped");
    expect(parsePreviewSmokeVerdict(null).verdict).toBe("skipped");
    expect(parsePreviewSmokeVerdict("").verdict).toBe("skipped");
  });
  it("skips on malformed JSON / unknown verdict", () => {
    expect(parsePreviewSmokeVerdict("<preview_smoke>{not json}</preview_smoke>").verdict).toBe("skipped");
    expect(parsePreviewSmokeVerdict('<preview_smoke>{"verdict":"maybe"}</preview_smoke>').verdict).toBe("skipped");
  });
});

describe("computeGateVerdict", () => {
  it("pass: build ok + no failed tests + preview not-fail", () => {
    expect(computeGateVerdict({ build_ok: true, tests_failed: 0 }, { verdict: "pass" })).toBe("pass");
    expect(computeGateVerdict({ build_ok: true, tests_failed: 0 }, { verdict: "skipped" })).toBe("pass");
  });
  it("fail: broken build", () => {
    expect(computeGateVerdict({ build_ok: false, tests_failed: 0 }, { verdict: "pass" })).toBe("fail");
  });
  it("fail: failing tests", () => {
    expect(computeGateVerdict({ build_ok: true, tests_failed: 2 }, { verdict: "pass" })).toBe("fail");
  });
  it("fail: preview smoke fail even when mechanical passes", () => {
    expect(computeGateVerdict({ build_ok: true, tests_failed: 0 }, { verdict: "fail" })).toBe("fail");
  });
});

describe("gateLabel + renderGateEvidenceMarkdown", () => {
  it("maps verdict → Zavi label", () => {
    expect(gateLabel("pass")).toBe(GATE_LABEL_PASS);
    expect(gateLabel("fail")).toBe(GATE_LABEL_FAIL);
  });
  it("renders a pass evidence block with review-ready framing", () => {
    const ev: GateEvidence = {
      build_ok: true,
      tests: { passed: 3, failed: 0 },
      typecheck_ok: true,
      preview_smoke: { verdict: "pass", evidence_md: "toggle visible" },
      gate_verdict: "pass",
    };
    const md = renderGateEvidenceMarkdown(ev);
    expect(md).toContain("review-ready");
    expect(md).toContain("3 passed, 0 failed");
    expect(md).toContain("toggle visible");
  });
  it("renders a fail evidence block with do-not-merge framing", () => {
    const ev: GateEvidence = {
      build_ok: false,
      tests: { passed: 1, failed: 2 },
      typecheck_ok: false,
      preview_smoke: { verdict: "skipped", evidence_md: "" },
      gate_verdict: "fail",
    };
    const md = renderGateEvidenceMarkdown(ev);
    expect(md).toContain("do NOT merge");
    expect(md).toContain("1 passed, 2 failed");
  });
});

type MockIo = { [K in keyof RefineGateIo]: Mock };
function makeIo(over: Partial<RefineGateIo> = {}): MockIo {
  const io = {
    loadEngineerParsed: vi.fn().mockResolvedValue({
      rendered_markdown: "Added a dark-mode toggle.",
      refine_gate_meta: {
        head_branch: "engineer/run-1",
        commit_sha: "abc1234",
        base_branch: "main",
        repo: "praxis-build/acme",
        title: "Add dark-mode toggle",
        build_ok: true,
        tests_passed: 3,
        tests_failed: 0,
        typecheck_ok: true,
      },
    }),
    probePreview: vi.fn().mockResolvedValue({ verdict: "pass", evidence_md: "root 200 (toggle visible)" }),
    openPrFromBranch: vi
      .fn()
      .mockResolvedValue({ ok: true, number: 42, url: "https://github.com/praxis-build/acme/pull/42", head_sha: "abc1234" }),
    addLabel: vi.fn().mockResolvedValue({ ok: true }),
    writeGateResult: vi.fn().mockResolvedValue(undefined),
    surfaceFailToThread: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  return io as unknown as MockIo;
}

const INPUT = {
  tenant_id: "t1",
  conductor_run_id: "cr1",
  engineer_run_id: "eng-run-1",
  qa_run_id: "qa-run-1",
};

describe("runRefineGate — GOOD change (mechanical pass + preview pass)", () => {
  it("opens the PR with zavi:review-ready + evidence, writes parsed.gate_evidence, no chat-fail surface", async () => {
    const io = makeIo();
    const r = await runRefineGate(INPUT, io);
    expect(r).toEqual({ resolved: true, gate_verdict: "pass", pr_url: "https://github.com/praxis-build/acme/pull/42" });

    expect(io.openPrFromBranch).toHaveBeenCalledTimes(1);
    const prArgs = io.openPrFromBranch.mock.calls[0][0];
    expect(prArgs.head_branch).toBe("engineer/run-1");
    expect(prArgs.body).toContain("review-ready");

    expect(io.addLabel).toHaveBeenCalledTimes(1);
    expect(io.addLabel.mock.calls[0][0].label).toBe(GATE_LABEL_PASS);

    const gr = io.writeGateResult.mock.calls[0][0];
    expect(gr.gate_evidence.gate_verdict).toBe("pass");
    expect(gr.pr_url).toBe("https://github.com/praxis-build/acme/pull/42");
    expect(gr.pr_head_sha).toBe("abc1234");

    expect(io.surfaceFailToThread).not.toHaveBeenCalled();
  });
});

describe("runRefineGate — INJECTED broken change (acceptance drill)", () => {
  it("mechanical fail (test_results.failed>0) → gate_verdict fail → PR opens zavi:gate-failed + chat surface + NO review-ready", async () => {
    const io = makeIo({
      loadEngineerParsed: vi.fn().mockResolvedValue({
        rendered_markdown: "Broken change.",
        refine_gate_meta: {
          head_branch: "engineer/run-2",
          commit_sha: "def5678",
          base_branch: "main",
          repo: "praxis-build/acme",
          title: "Broken",
          build_ok: true,
          tests_passed: 1,
          tests_failed: 3,
          typecheck_ok: true,
        },
      }),
    });
    const r = await runRefineGate(INPUT, io);
    expect(r).toMatchObject({ resolved: true, gate_verdict: "fail" });

    expect(io.openPrFromBranch).toHaveBeenCalledTimes(1);
    expect(io.addLabel.mock.calls[0][0].label).toBe(GATE_LABEL_FAIL);
    expect(io.addLabel.mock.calls[0][0].label).not.toBe(GATE_LABEL_PASS);

    expect(io.openPrFromBranch.mock.calls[0][0].body).toContain("do NOT merge");
    expect(io.writeGateResult.mock.calls[0][0].gate_evidence.gate_verdict).toBe("fail");

    expect(io.surfaceFailToThread).toHaveBeenCalledTimes(1);
  });

  it("mechanical fail (build_ok false / red typecheck) → gate_verdict fail", async () => {
    const io = makeIo({
      loadEngineerParsed: vi.fn().mockResolvedValue({
        refine_gate_meta: {
          head_branch: "engineer/run-3",
          commit_sha: "c3",
          base_branch: "main",
          repo: "praxis-build/acme",
          title: "Red build",
          build_ok: false,
          tests_passed: 0,
          tests_failed: 0,
          typecheck_ok: false,
        },
      }),
    });
    const r = await runRefineGate(INPUT, io);
    expect(r).toMatchObject({ gate_verdict: "fail" });
    expect(io.addLabel.mock.calls[0][0].label).toBe(GATE_LABEL_FAIL);
  });
});

describe("runRefineGate — C1.5 preview probe fail (mechanical pass but probe verdict fail)", () => {
  it("→ gate_verdict fail (blocks)", async () => {
    const io = makeIo({
      probePreview: vi.fn().mockResolvedValue({ verdict: "fail", evidence_md: "Preview root returned HTTP 500" }),
    });
    const r = await runRefineGate(INPUT, io);
    expect(r).toMatchObject({ gate_verdict: "fail" });
    expect(io.addLabel.mock.calls[0][0].label).toBe(GATE_LABEL_FAIL);
    expect(io.surfaceFailToThread).toHaveBeenCalledTimes(1);
  });

  it("passes the branch + run_id + expected markers to the probe", async () => {
    const io = makeIo({
      loadEngineerParsed: vi.fn().mockResolvedValue({
        rendered_markdown: "Added a 'Dark mode' button.",
        expected_markers: ["Dark mode"],
        refine_gate_meta: {
          head_branch: "engineer/run-1",
          commit_sha: "abc1234",
          base_branch: "main",
          repo: "praxis-build/acme",
          title: "Add dark-mode toggle",
          build_ok: true,
          tests_passed: 3,
          tests_failed: 0,
          typecheck_ok: true,
        },
      }),
    });
    await runRefineGate(INPUT, io);
    const probeArgs = io.probePreview.mock.calls[0][0];
    expect(probeArgs.branch).toBe("engineer/run-1");
    expect(probeArgs.repo).toBe("praxis-build/acme");
    expect(probeArgs.run_id).toBe("eng-run-1");
    expect(probeArgs.expected_markers).toEqual(["Dark mode"]);
  });
});

describe("runRefineGate — fail-safety", () => {
  it("no refine_gate_meta → resolves false (nothing to open), never opens a PR", async () => {
    const io = makeIo({ loadEngineerParsed: vi.fn().mockResolvedValue({ rendered_markdown: "no meta" }) });
    const r = await runRefineGate(INPUT, io);
    expect(r).toEqual({ resolved: false, reason: "no_refine_gate_meta" });
    expect(io.openPrFromBranch).not.toHaveBeenCalled();
  });

  it("PR open failure → resolved false, NEVER labels/merges", async () => {
    const io = makeIo({ openPrFromBranch: vi.fn().mockResolvedValue({ ok: false, error: "boom" }) });
    const r = await runRefineGate(INPUT, io);
    expect(r).toEqual({ resolved: false, reason: "pr_open_failed" });
    expect(io.addLabel).not.toHaveBeenCalled();
  });

  it("a preview probe that skipped (infra flake / disabled) does NOT fail a mechanically-good change", async () => {
    const io = makeIo({
      probePreview: vi.fn().mockResolvedValue({ verdict: "skipped", evidence_md: "no live preview" }),
    });
    const r = await runRefineGate(INPUT, io);
    expect(r).toMatchObject({ gate_verdict: "pass" });
    expect(io.addLabel.mock.calls[0][0].label).toBe(GATE_LABEL_PASS);
  });
});
