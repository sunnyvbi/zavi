
import { describe, it, expect, vi } from "vitest";
import { maybeAutoRemediate } from "../engineer-postdeploy-verify";
import { MAX_REMEDIATION_ATTEMPTS } from "@/services/agents/postdeploy-remediate";
import { NoProvisionedRepo } from "@/services/agents/refine-product";

function refineSpy() {
  return vi
    .fn()
    .mockResolvedValue({ conductor_run_id: "refine_run_1" });
}

describe("maybeAutoRemediate (worker glue: failure → auto-fix → re-verify, bounded)", () => {
  it("postdeploy_5xx with no prior attempts → fires ONE refine, attempt 1", async () => {
    const refine = refineSpy();
    const r = await maybeAutoRemediate(
      {
        tenant_id: "tenant_a",
        verdict: "postdeploy_5xx",
        status_code: 500,
        snippet: "NEXT_PUBLIC_SUPABASE_URL is required",
        prior_remediations: 0,
      },
      refine,
    );
    expect(r.remediated).toBe(true);
    if (r.remediated) {
      expect(r.attempt).toBe(1);
      expect(r.conductor_run_id).toBe("refine_run_1");
    }
    expect(refine).toHaveBeenCalledTimes(1);
    const arg = refine.mock.calls[0][0];
    expect(arg.tenant_id).toBe("tenant_a");
    expect(arg.remediation_attempt).toBe(1);
    expect(arg.message).toContain("HTTP 500");
    expect(arg.message).toContain("NEXT_PUBLIC_SUPABASE_URL");
  });

  it("postdeploy_next_error → fires a refine (runtime crash is fixable)", async () => {
    const refine = refineSpy();
    const r = await maybeAutoRemediate(
      {
        tenant_id: "t",
        verdict: "postdeploy_next_error",
        status_code: 200,
        snippet: "__next_error__digest=1",
        prior_remediations: 0,
      },
      refine,
    );
    expect(r.remediated).toBe(true);
    expect(refine).toHaveBeenCalledTimes(1);
  });

  it("CLEAN DEPLOY ('success') → does NOTHING (no refine enqueued)", async () => {
    const refine = refineSpy();
    const r = await maybeAutoRemediate(
      {
        tenant_id: "t",
        verdict: "success",
        status_code: 200,
        snippet: "",
        prior_remediations: 0,
      },
      refine,
    );
    expect(r.remediated).toBe(false);
    expect(refine).not.toHaveBeenCalled();
  });

  it("deploy_timeout → no refine (slow/ambiguous, don't cry-wolf)", async () => {
    const refine = refineSpy();
    const r = await maybeAutoRemediate(
      {
        tenant_id: "t",
        verdict: "deploy_timeout",
        status_code: null,
        snippet: "fetch aborted",
        prior_remediations: 0,
      },
      refine,
    );
    expect(r.remediated).toBe(false);
    expect(refine).not.toHaveBeenCalled();
  });

  it("BOUNDED: at the cap, a still-broken 5xx fires NO refine", async () => {
    const refine = refineSpy();
    const r = await maybeAutoRemediate(
      {
        tenant_id: "t",
        verdict: "postdeploy_5xx",
        status_code: 500,
        snippet: "still broken",
        prior_remediations: MAX_REMEDIATION_ATTEMPTS,
      },
      refine,
    );
    expect(r.remediated).toBe(false);
    if (!r.remediated) expect(r.reason).toContain("bound reached");
    expect(refine).not.toHaveBeenCalled();
  });

  it("BOUNDED end-to-end: walking the fix→re-verify loop fires exactly MAX refines", async () => {
    const refine = refineSpy();
    let prior = 0;
    let fires = 0;
    for (let guard = 0; guard < 100; guard++) {
      const r = await maybeAutoRemediate(
        {
          tenant_id: "t",
          verdict: "postdeploy_5xx",
          status_code: 500,
          snippet: "broken",
          prior_remediations: prior,
        },
        refine,
      );
      if (!r.remediated) break;
      fires++;
      prior = r.attempt;
    }
    expect(fires).toBe(MAX_REMEDIATION_ATTEMPTS);
    expect(refine).toHaveBeenCalledTimes(MAX_REMEDIATION_ATTEMPTS);
  });

  it("refine enqueue failure (NoProvisionedRepo) is swallowed — worker never throws", async () => {
    const refine = vi.fn().mockRejectedValue(new NoProvisionedRepo("tenant_a"));
    const r = await maybeAutoRemediate(
      {
        tenant_id: "tenant_a",
        verdict: "postdeploy_5xx",
        status_code: 500,
        snippet: "x",
        prior_remediations: 0,
      },
      refine,
    );
    expect(r.remediated).toBe(false);
    if (!r.remediated) expect(r.reason).toContain("no_provisioned_repo");
  });

  it("refine enqueue failure (slot in flight) is swallowed too", async () => {
    const refine = vi.fn().mockRejectedValue(new Error("double_build in flight"));
    const r = await maybeAutoRemediate(
      {
        tenant_id: "t",
        verdict: "postdeploy_5xx",
        status_code: 500,
        snippet: "x",
        prior_remediations: 0,
      },
      refine,
    );
    expect(r.remediated).toBe(false);
    if (!r.remediated) expect(r.reason).toContain("refine_enqueue_failed");
  });
});
