import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const cacheSiteAuditRun = vi.fn(async () => {});
const cacheSeoAuditFailure = vi.fn(async () => {});
const runSiteAudit = vi.fn();
vi.mock("../seo/snapshot", () => ({
  cacheSiteAuditRun: (...a: unknown[]) => cacheSiteAuditRun(...(a as [])),
  cacheSeoAuditFailure: (...a: unknown[]) => cacheSeoAuditFailure(...(a as [])),
}));
vi.mock("../seo/run", () => ({
  runSiteAudit: (...a: unknown[]) => runSiteAudit(...a),
  seoShapeOf: () => ({ pages_analyzed: 1, findings: [] }),
}));

import { seoAuditTool } from "../seo_audit";

const base = { tenant_id: "t1", log: () => {} };
beforeEach(() => {
  vi.clearAllMocks();
});

describe("growth_seo_audit cache writes", () => {
  it("writes-suppressed: no cache write on success or failure", async () => {
    runSiteAudit.mockResolvedValueOnce({});
    await seoAuditTool.execute({ ...base, writes_suppressed: true }, {});
    runSiteAudit.mockRejectedValueOnce(new ExpectedToolError("site_unreachable", "down"));
    await expect(seoAuditTool.execute({ ...base, writes_suppressed: true }, {})).rejects.toThrow();
    expect(cacheSiteAuditRun).not.toHaveBeenCalled();
    expect(cacheSeoAuditFailure).not.toHaveBeenCalled();
  });

  it("normal run: caches as before", async () => {
    runSiteAudit.mockResolvedValueOnce({});
    await seoAuditTool.execute(base, {});
    expect(cacheSiteAuditRun).toHaveBeenCalledTimes(1);
  });
});
