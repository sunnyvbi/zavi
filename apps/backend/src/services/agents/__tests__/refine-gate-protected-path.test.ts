
import { describe, it, expect, vi, type Mock } from "vitest";
import {
  runRefineGate,
  GATE_LABEL_PASS,
  GATE_LABEL_FAIL,
  type RefineGateIo,
} from "@/services/agents/refine-gate";

type MockIo = { [K in keyof RefineGateIo]: Mock };

function makeIo(parsedOver: Record<string, unknown>): MockIo {
  return {
    loadEngineerParsed: vi.fn().mockResolvedValue({
      rendered_markdown: "Change.",
      refine_gate_meta: {
        head_branch: "engineer/run-x",
        commit_sha: "abc1234",
        base_branch: "main",
        repo: "praxis-build/acme",
        title: "A change",
        build_ok: true,
        tests_passed: 5,
        tests_failed: 0,
        typecheck_ok: true,
      },
      ...parsedOver,
    }),
    probePreview: vi.fn().mockResolvedValue({ verdict: "pass", evidence_md: "root 200" }),
    openPrFromBranch: vi.fn().mockResolvedValue({
      ok: true,
      number: 7,
      url: "https://github.com/praxis-build/acme/pull/7",
      head_sha: "abc1234",
    }),
    addLabel: vi.fn().mockResolvedValue({ ok: true }),
    writeGateResult: vi.fn().mockResolvedValue(undefined),
    surfaceFailToThread: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockIo;
}

const INPUT = {
  tenant_id: "t1",
  conductor_run_id: "cr1",
  engineer_run_id: "eng-1",
  qa_run_id: "qa-1",
};

describe("runRefineGate — protected path via parsed.files[].path (DEFAULT globs)", () => {
  it("supabase/migrations/** diff → FAIL 'protected_path' + gate-failed, even though build+tests+preview pass", async () => {
    const io = makeIo({
      files: [
        { path: "src/pages/Home.tsx", action: "modify", content: "x" },
        { path: "supabase/migrations/20260101_add.sql", action: "create", content: "y" },
      ],
    });
    const r = await runRefineGate(INPUT, io);
    expect(r).toMatchObject({ resolved: true, gate_verdict: "fail", hold_reason: "protected_path" });

    expect(io.openPrFromBranch).toHaveBeenCalledTimes(1);
    expect(io.addLabel.mock.calls[0][0].label).toBe(GATE_LABEL_FAIL);
    expect(io.addLabel.mock.calls[0][0].label).not.toBe(GATE_LABEL_PASS);

    const gr = io.writeGateResult.mock.calls[0][0];
    expect(gr.gate_evidence.gate_verdict).toBe("fail");
    expect(gr.gate_evidence.protected_paths).toEqual([
      { path: "supabase/migrations/20260101_add.sql", glob: "supabase/migrations/**" },
    ]);
    expect(io.openPrFromBranch.mock.calls[0][0].body).toContain("protected path");

    expect(io.surfaceFailToThread).toHaveBeenCalledTimes(1);
  });

  it("honors the post-run stamp (parsed.protected_paths) for APP-specific globs even if parsed.files is absent", async () => {
    const io = makeIo({
      protected_paths: [{ path: "src/payments/checkout.ts", glob: "**/payments/**" }],
    });
    const r = await runRefineGate(INPUT, io);
    expect(r).toMatchObject({ gate_verdict: "fail", hold_reason: "protected_path" });
    expect(io.addLabel.mock.calls[0][0].label).toBe(GATE_LABEL_FAIL);
  });
});

describe("runRefineGate — clean diff is unchanged C1 (pass)", () => {
  it("non-protected files + all gates green → PASS review-ready, no hold_reason", async () => {
    const io = makeIo({
      files: [
        { path: "src/pages/Home.tsx", action: "modify", content: "x" },
        { path: "src/components/Toggle.tsx", action: "create", content: "y" },
      ],
    });
    const r = await runRefineGate(INPUT, io);
    expect(r).toMatchObject({ resolved: true, gate_verdict: "pass" });
    expect((r as { hold_reason?: string }).hold_reason).toBeUndefined();
    expect(io.addLabel.mock.calls[0][0].label).toBe(GATE_LABEL_PASS);
    expect(io.surfaceFailToThread).not.toHaveBeenCalled();
  });
});
