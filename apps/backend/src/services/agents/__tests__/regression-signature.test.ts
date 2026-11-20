import { describe, it, expect } from "vitest";
import {
  computeRegressionSignature,
  buildSignaturePreimage,
  classifyCodeClass,
  classifyOutcomeClass,
  safeToolName,
  strictScrub,
  SIG_VERSION,
  type SignatureInput,
} from "../regression-signature";

describe("computeRegressionSignature", () => {
  const base: SignatureInput = {
    agent_slug: "engineer",
    engine: "claude",
    failing_tool_name: "github__create_pr",
    status: "parse_failed",
    raw_code: "parse_failed: model returned non-JSON",
    steps: [
      { tool_name: "github__list_files", code: "ok" },
      { tool_name: "github__create_pr", code: "parse_failed" },
    ],
  };

  it("is deterministic — same input yields same hash", () => {
    expect(computeRegressionSignature(base).signature).toBe(
      computeRegressionSignature(base).signature,
    );
  });

  it("is a 64-char sha256 hex", () => {
    expect(computeRegressionSignature(base).signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the enum code_class + outcome_class, not raw code", () => {
    const r = computeRegressionSignature(base);
    expect(r.code_class).toBe("parse_failed");
    expect(r.outcome_class).toBe("parse_failed");
    expect(r.sig_version).toBe(SIG_VERSION);
  });

  it("is CROSS-TENANT STABLE — identical failure on two tenants => identical sig", () => {
    const tenantA = computeRegressionSignature(base);
    const tenantB = computeRegressionSignature({ ...base });
    expect(tenantA.signature).toBe(tenantB.signature);
  });

  it("DISTINGUISHES different failure classes", () => {
    const a = computeRegressionSignature(base);
    const b = computeRegressionSignature({ ...base, raw_code: "dispatch: boom" });
    const c = computeRegressionSignature({ ...base, agent_slug: "pm" });
    expect(a.signature).not.toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
  });

  it("is STABLE across raw-code variants that bucket to the same class", () => {
    const a = computeRegressionSignature({
      ...base,
      raw_code: "parse_failed: unexpected token at position 42",
    });
    const b = computeRegressionSignature({
      ...base,
      raw_code: "parse_failed: model returned prose not json",
    });
    expect(a.signature).toBe(b.signature);
  });

  it("PII PROPERTY: no email/path/uuid/secret/digits survive into the preimage", () => {
    const poisoned: SignatureInput = {
      agent_slug: "support-lead",
      engine: "claude",
      failing_tool_name: "slack__post_message",
      status: "failed",
      raw_code:
        "tool_use_errored: failed to DM jane.doe@acme.com about /Users/secret/path/file.csv " +
        "(channel C0ABZAZD8MA, token sk-live-deadbeefcafebabe1234567890ab, " +
        "tenant 73db45ff-457e-4541-bc8f-bdb625390204, phone 4155551234)",
      steps: [
        {
          tool_name: "slack__post_message",
          code: "error: user bob@example.org not found in /workspace/abc/def",
        },
        { tool_name: "weird tool: admin@corp.com", code: "boom 9999" },
      ],
    };

    const preimage = JSON.stringify(buildSignaturePreimage(poisoned));

    const FORBIDDEN = [
      "jane.doe@acme.com",
      "bob@example.org",
      "admin@corp.com",
      "/Users/secret/path/file.csv",
      "/workspace/abc/def",
      "C0ABZAZD8MA",
      "sk-live-deadbeefcafebabe1234567890ab",
      "73db45ff-457e-4541-bc8f-bdb625390204",
      "4155551234",
      "9999",
    ];
    for (const tok of FORBIDDEN) {
      expect(preimage).not.toContain(tok);
    }
    expect(preimage).not.toMatch(/@/);
    expect(computeRegressionSignature(poisoned).signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("strictScrub removes emails, paths, uuids, long hex, and digits", () => {
    const dirty =
      "fail user a@b.com path /x/y/z id 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d hex deadbeefcafebabe00 n 12345";
    const clean = strictScrub(dirty);
    expect(clean).not.toMatch(/@/);
    expect(clean).not.toMatch(/\d/);
    expect(clean).not.toMatch(/deadbeef/);
    expect(clean).not.toContain("/x/y/z");
  });

  it("safeToolName passes slug-shaped names, buckets content-bearing ones", () => {
    expect(safeToolName("github__create_pr")).toBe("github__create_pr");
    expect(safeToolName("weird tool: a@b.com")).toBe("unknown_tool");
    expect(safeToolName(null)).toBe("none");
  });

  it("classifyCodeClass maps known prefixes to enums, else other", () => {
    expect(classifyCodeClass("parse_failed: x")).toBe("parse_failed");
    expect(classifyCodeClass("dispatch: boom")).toBe("dispatch_throw");
    expect(classifyCodeClass("tool_use_errored")).toBe("tool_use_errored");
    expect(classifyCodeClass("request timed out")).toBe("tool_timeout");
    expect(classifyCodeClass("some random thing")).toBe("other");
    expect(classifyCodeClass(null)).toBe("other");
  });

  it("classifyOutcomeClass maps empty (Bug-B) + statuses", () => {
    expect(classifyOutcomeClass("success", "empty")).toBe("empty");
    expect(classifyOutcomeClass("parse_failed", null)).toBe("parse_failed");
    expect(classifyOutcomeClass("dispatch_error", null)).toBe("dispatch_error");
    expect(classifyOutcomeClass("failed", null)).toBe("failed");
  });

  it("caps the step sequence so a pathological run can't bloat the preimage", () => {
    const manySteps = Array.from({ length: 200 }, (_, i) => ({
      tool_name: `tool_${i}`,
      code: "ok",
    }));
    const pre = buildSignaturePreimage({ ...base, steps: manySteps });
    expect(pre.seq.length).toBeLessThanOrEqual(40);
  });
});
