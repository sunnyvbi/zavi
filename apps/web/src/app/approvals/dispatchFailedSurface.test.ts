import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Decision } from "./approvalDecision";
import { describe, it, expect, expectTypeOf } from "vitest";

const island = readFileSync(join(__dirname, "ApprovalsIsland.tsx"), "utf8");

describe("BUG 1 — the approvals page asks for failed decisions", () => {
  it("fetches the dispatch_failed status, not just the default proposed", () => {
    expect(island).toContain('apiFetch("/api/approvals?status=dispatch_failed")');
  });

  it("reads the reason the backend already returns", () => {
    expect(island).toMatch(/dispatch_error/);
    expectTypeOf<Decision["dispatch_error"]>().toEqualTypeOf<string | null | undefined>();
  });

  it("renders the raw reason rather than mapping it to friendly copy", () => {
    expect(island).toMatch(/d\.dispatch_error\?\.trim\(\)/);
    expect(island).toMatch(/No reason was recorded for this failure/);
  });

  it("does not blank the page when only the failed fetch fails", () => {
    expect(island).toMatch(/if \(failedRes\.ok\)/);
  });

  it("tells the operator nothing was done", () => {
    expect(island).toMatch(/could not carry them out\. Nothing/);
  });
});
