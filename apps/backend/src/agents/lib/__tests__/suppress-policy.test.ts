
import { describe, it, expect } from "vitest";
import { suppressAnsweredNoAction } from "@/agents/lib/suppress-policy";

describe("suppressAnsweredNoAction", () => {
  const text = "I'm not staging a PR — the critic flagged a P1. Here's why.";

  it("critic_fail WITH a real answer → answered (the reported bug)", () => {
    expect(suppressAnsweredNoAction("critic_fail", text)).toBe(true);
  });

  it("task_mismatch WITH a real answer → answered", () => {
    expect(suppressAnsweredNoAction("task_mismatch", text)).toBe(true);
  });

  it("refused_envelope WITH a real answer → answered (regression guard)", () => {
    expect(suppressAnsweredNoAction("refused_envelope", text)).toBe(true);
  });

  it("prose_fallback WITH a real answer → answered (regression guard)", () => {
    expect(suppressAnsweredNoAction("prose_fallback", text)).toBe(true);
  });

  it("over_ship_cap WITH a real answer → answered (PR #342 regression guard)", () => {
    expect(suppressAnsweredNoAction("over_ship_cap", text)).toBe(true);
  });

  it("typecheck_failed WITH a real answer → answered (verification-gate hold)", () => {
    expect(suppressAnsweredNoAction("typecheck_failed", text)).toBe(true);
  });

  it("tests_failed WITH a real answer → answered (verification-gate hold)", () => {
    expect(suppressAnsweredNoAction("tests_failed", text)).toBe(true);
  });

  it("app_verify_missing WITH a real answer → answered (verification-gate hold)", () => {
    expect(suppressAnsweredNoAction("app_verify_missing", text)).toBe(true);
  });

  it("wiring_unverified_block WITH a real answer → answered (verification-gate hold)", () => {
    expect(suppressAnsweredNoAction("wiring_unverified_block", text)).toBe(true);
  });

  it("typecheck_failed with NO text → not answered (nothing to show = real failure)", () => {
    expect(suppressAnsweredNoAction("typecheck_failed", "")).toBe(false);
    expect(suppressAnsweredNoAction("typecheck_failed", undefined)).toBe(false);
  });

  it("critic_fail with NO text → not answered (nothing to show = real failure)", () => {
    expect(suppressAnsweredNoAction("critic_fail", "")).toBe(false);
    expect(suppressAnsweredNoAction("critic_fail", "   ")).toBe(false);
    expect(suppressAnsweredNoAction("critic_fail", undefined)).toBe(false);
  });

  it("empty_diff stays a non-answer (deliberately out of scope)", () => {
    expect(suppressAnsweredNoAction("empty_diff", text)).toBe(false);
  });

  it("builder_rejected stays a non-answer (platform couldn't ship)", () => {
    expect(suppressAnsweredNoAction("builder_rejected:line_cap", text)).toBe(false);
  });

  it("all_bases_conflict WITH a real answer → answered (eng-review 2026-06-27 dev-branch fix)", () => {
    expect(suppressAnsweredNoAction("all_bases_conflict", text)).toBe(true);
  });

  it("all_bases_conflict with NO text → not answered (nothing to show = real failure)", () => {
    expect(suppressAnsweredNoAction("all_bases_conflict", "")).toBe(false);
    expect(suppressAnsweredNoAction("all_bases_conflict", undefined)).toBe(false);
  });

  it("base_build_error stays a non-answer EVEN with text (infra failure ≠ held answer)", () => {
    expect(suppressAnsweredNoAction("base_build_error", text)).toBe(false);
    expect(suppressAnsweredNoAction("base_build_error", "")).toBe(false);
  });
});
