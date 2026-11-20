import { describe, it, expect } from "vitest";
import {
  classifyEngineerPrApproval,
  requiresExplicitShipRed,
  isSoftYes,
  readApprovalClass,
  type ApprovalClass,
} from "../approval-class";

function env(opts: {
  status?: "passed" | "failed" | "couldnt_run" | "not_run";
  risk_class?: string;
  attribution?:
    | { kind: "attributed"; new_failures: string[]; pre_existing: string[] }
    | { kind: "unknown"; why: string };
}): Record<string, unknown> {
  const e: Record<string, unknown> = {};
  if (opts.risk_class !== undefined) e.risk_class = opts.risk_class;
  if (opts.status !== undefined) e.verify = { status: opts.status };
  if (opts.attribution !== undefined) e.test_attribution = opts.attribution;
  return e;
}

describe("classifyEngineerPrApproval — the 5-class table", () => {
  it("passed → normal_yes", () => {
    expect(classifyEngineerPrApproval(env({ status: "passed" }))).toBe("normal_yes");
  });

  it("trivial risk_class → normal_yes even when red", () => {
    expect(
      classifyEngineerPrApproval(
        env({
          status: "failed",
          risk_class: "trivial",
          attribution: { kind: "attributed", new_failures: ["a"], pre_existing: [] },
        }),
      ),
    ).toBe("normal_yes");
  });

  it("failed + attributed + new_failures>0 → ship_red (the ONLY strict class)", () => {
    const cls = classifyEngineerPrApproval(
      env({
        status: "failed",
        attribution: { kind: "attributed", new_failures: ["Login > rejects"], pre_existing: ["x"] },
      }),
    );
    expect(cls).toBe("ship_red");
    expect(requiresExplicitShipRed(cls)).toBe(true);
    expect(isSoftYes(cls)).toBe(false);
  });

  it("failed + attributed + new_failures=0 (all pre-existing) → normal_yes (agent broke nothing)", () => {
    expect(
      classifyEngineerPrApproval(
        env({
          status: "failed",
          attribution: { kind: "attributed", new_failures: [], pre_existing: ["a", "b"] },
        }),
      ),
    ).toBe("normal_yes");
  });

  it("failed + attribution unknown → soft_yes_red (red, not provably the agent's fault)", () => {
    const cls = classifyEngineerPrApproval(
      env({ status: "failed", attribution: { kind: "unknown", why: "base suite unparseable" } }),
    );
    expect(cls).toBe("soft_yes_red");
    expect(requiresExplicitShipRed(cls)).toBe(false);
    expect(isSoftYes(cls)).toBe(true);
  });

  it("failed + attribution ABSENT → soft_yes_red (fail-open, no token on every red-repo PR)", () => {
    expect(classifyEngineerPrApproval(env({ status: "failed" }))).toBe("soft_yes_red");
  });

  it("couldnt_run → soft_yes_couldnt_run", () => {
    const cls = classifyEngineerPrApproval(env({ status: "couldnt_run" }));
    expect(cls).toBe("soft_yes_couldnt_run");
    expect(isSoftYes(cls)).toBe(true);
  });

  it("not_run (non-trivial) → soft_yes_not_run", () => {
    expect(classifyEngineerPrApproval(env({ status: "not_run" }))).toBe("soft_yes_not_run");
  });

  it("absent verify (legacy/stashed envelope) → normal_yes (FAIL OPEN — never manufacture friction)", () => {
    expect(classifyEngineerPrApproval({})).toBe("normal_yes");
    expect(classifyEngineerPrApproval(null)).toBe("normal_yes");
    expect(classifyEngineerPrApproval(env({ risk_class: "medium" }))).toBe("normal_yes");
  });

  it("garbage verify.status → normal_yes (defensive, fail-open)", () => {
    expect(classifyEngineerPrApproval({ verify: { status: "weird" } })).toBe("normal_yes");
  });
});

describe("readApprovalClass", () => {
  it("round-trips every valid class", () => {
    const all: ApprovalClass[] = [
      "ship_red",
      "soft_yes_red",
      "soft_yes_couldnt_run",
      "soft_yes_not_run",
      "normal_yes",
    ];
    for (const c of all) expect(readApprovalClass({ approval_class: c })).toBe(c);
  });
  it("returns null for absent/garbage", () => {
    expect(readApprovalClass({})).toBeNull();
    expect(readApprovalClass(null)).toBeNull();
    expect(readApprovalClass({ approval_class: "nope" })).toBeNull();
  });
});
