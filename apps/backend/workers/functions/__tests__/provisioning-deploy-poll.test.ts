import { describe, it, expect, vi, afterEach } from "vitest";
import {
  decideDeployStatus,
  pollDeployStatuses,
  reconcileFailedRow,
  type DeployPollDeps,
} from "../provisioning-deploy-poll";

describe("decideDeployStatus (A5 — pure deploy-status mapping)", () => {
  it("'live' → awaiting_liveness (necessary, not sufficient — probe decides ready)", () => {
    expect(decideDeployStatus("live")).toBe("awaiting_liveness");
  });

  it("failed/canceled/deactivated families → failed", () => {
    for (const s of ["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"]) {
      expect(decideDeployStatus(s)).toBe("failed");
    }
  });

  it("in-progress / created / unknown / missing → still_provisioning (leave alone)", () => {
    for (const s of ["created", "build_in_progress", "update_in_progress", "pre_deploy_in_progress", "weird", "", null, undefined]) {
      expect(decideDeployStatus(s)).toBe("still_provisioning");
    }
  });
});

function deps(over: Partial<DeployPollDeps> = {}): DeployPollDeps & {
  loadProvisioningHosting: ReturnType<typeof vi.fn>;
  fetchLatestDeployStatus: ReturnType<typeof vi.fn>;
  fetchServiceUrl: ReturnType<typeof vi.fn>;
  probeLiveness: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  setProductUrl: ReturnType<typeof vi.fn>;
  isBuildFlowTenant: ReturnType<typeof vi.fn>;
  bumpProvisioning: ReturnType<typeof vi.fn>;
} {
  return {
    loadProvisioningHosting: vi.fn().mockResolvedValue([]),
    fetchLatestDeployStatus: vi.fn().mockResolvedValue(null),
    fetchServiceUrl: vi.fn().mockResolvedValue("https://x.onrender.com"),
    probeLiveness: vi.fn().mockResolvedValue(true),
    setStatus: vi.fn().mockResolvedValue(undefined),
    setProductUrl: vi.fn().mockResolvedValue(undefined),
    isBuildFlowTenant: vi.fn().mockResolvedValue(true),
    bumpProvisioning: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as DeployPollDeps & {
    loadProvisioningHosting: ReturnType<typeof vi.fn>;
    fetchLatestDeployStatus: ReturnType<typeof vi.fn>;
    fetchServiceUrl: ReturnType<typeof vi.fn>;
    probeLiveness: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    setProductUrl: ReturnType<typeof vi.fn>;
    isBuildFlowTenant: ReturnType<typeof vi.fn>;
    bumpProvisioning: ReturnType<typeof vi.fn>;
  };
}

describe("pollDeployStatuses (A5 + P0-2 liveness)", () => {
  it("flips to 'ready' ONLY when deploy='live' AND a real URL serves a 2xx — persists the re-fetched URL", async () => {
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "t1", external_ref: { render_service_id: "srv_1", url: null } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://t1.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
    });
    const r = await pollDeployStatuses(d);
    expect(d.fetchServiceUrl).toHaveBeenCalledWith("srv_1");
    expect(d.probeLiveness).toHaveBeenCalledWith("https://t1.onrender.com");
    expect(d.setStatus).toHaveBeenCalledWith("t1", "ready", {
      render_service_id: "srv_1",
      url: "https://t1.onrender.com",
    });
    expect(r).toMatchObject({ checked: 1, ready: 1, failed: 0, still_provisioning: 0 });
  });

  it("FALSE-LIVE guard: deploy='live' but the URL probe is non-2xx → NOT ready, stays provisioning, bumps attempts", async () => {
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "t9", external_ref: { render_service_id: "srv_9", url: "https://t9.onrender.com" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://t9.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(false),
    });
    const r = await pollDeployStatuses(d);
    expect(d.setStatus).not.toHaveBeenCalled();
    expect(d.bumpProvisioning).toHaveBeenCalledWith("t9", {
      render_service_id: "srv_9",
      url: "https://t9.onrender.com",
      liveness_attempts: 1,
    });
    expect(r).toMatchObject({ checked: 1, ready: 0, failed: 0, still_provisioning: 1 });
  });

  it("STUCK-RESOLVING guard: deploy='live' but service URL still null → not ready, bumps attempts (never probes a null url)", async () => {
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "t10", external_ref: { render_service_id: "srv_10" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue(null),
      probeLiveness: vi.fn().mockResolvedValue(true),
    });
    const r = await pollDeployStatuses(d);
    expect(d.probeLiveness).not.toHaveBeenCalled();
    expect(d.setStatus).not.toHaveBeenCalled();
    expect(d.bumpProvisioning).toHaveBeenCalledWith("t10", {
      render_service_id: "srv_10",
      liveness_attempts: 1,
    });
    expect(r).toMatchObject({ checked: 1, still_provisioning: 1 });
  });

  it("NO-SPIN: a 'live'-but-never-serving deploy → 'failed' once attempts reach the cap", async () => {
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "t11", external_ref: { render_service_id: "srv_11", liveness_attempts: 9 } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://t11.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(false),
    });
    const r = await pollDeployStatuses(d);
    expect(d.bumpProvisioning).not.toHaveBeenCalled();
    expect(d.setStatus).toHaveBeenCalledWith("t11", "failed", {
      render_service_id: "srv_11",
      url: "https://t11.onrender.com",
      liveness_attempts: 10,
      last_error: "deploy reported live but the app never served a 2xx within the liveness window",
    });
    expect(r).toMatchObject({ checked: 1, failed: 1, still_provisioning: 0 });
  });

  it("flips to 'failed' on a failed deploy (with a surfaced last_error)", async () => {
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "t2", external_ref: { render_service_id: "srv_2" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("build_failed"),
    });
    const r = await pollDeployStatuses(d);
    expect(d.fetchServiceUrl).not.toHaveBeenCalled();
    expect(d.setStatus).toHaveBeenCalledWith("t2", "failed", {
      render_service_id: "srv_2",
      last_error: "render deploy failed/canceled",
    });
    expect(r).toMatchObject({ checked: 1, ready: 0, failed: 1 });
  });

  it("does NOT flip while the deploy is still building (no premature 'live', no probe)", async () => {
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "t3", external_ref: { render_service_id: "srv_3" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("build_in_progress"),
    });
    const r = await pollDeployStatuses(d);
    expect(d.fetchServiceUrl).not.toHaveBeenCalled();
    expect(d.probeLiveness).not.toHaveBeenCalled();
    expect(d.setStatus).not.toHaveBeenCalled();
    expect(d.bumpProvisioning).not.toHaveBeenCalled();
    expect(r).toMatchObject({ checked: 1, ready: 0, failed: 0, still_provisioning: 1 });
  });

  it("skips a row with no render_service_id (can't poll)", async () => {
    const d = deps({
      loadProvisioningHosting: vi.fn().mockResolvedValue([{ tenant_id: "t4", external_ref: {} }]),
    });
    const r = await pollDeployStatuses(d);
    expect(d.fetchLatestDeployStatus).not.toHaveBeenCalled();
    expect(r).toMatchObject({ checked: 0 });
  });

  it("one bad service can't stall the sweep — counts errored, continues", async () => {
    const d = deps({
      loadProvisioningHosting: vi.fn().mockResolvedValue([
        { tenant_id: "t5", external_ref: { render_service_id: "bad" } },
        { tenant_id: "t6", external_ref: { render_service_id: "good" } },
      ]),
      fetchLatestDeployStatus: vi.fn().mockImplementation(async (id: string) => {
        if (id === "bad") throw new Error("render 500");
        return "live";
      }),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://good.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
    });
    const r = await pollDeployStatuses(d);
    expect(r).toMatchObject({ checked: 2, ready: 1, errored: 1 });
    expect(d.setStatus).toHaveBeenCalledWith("t6", "ready", {
      render_service_id: "good",
      url: "https://good.onrender.com",
    });
  });

  it("derives tenant_id from the ROW, not any payload (C8)", async () => {
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "row-tenant", external_ref: { render_service_id: "srv_x" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://srvx.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
    });
    await pollDeployStatuses(d);
    expect(d.setStatus.mock.calls[0][0]).toBe("row-tenant");
  });

  it("SWAP: calls swapPreviewOnReady(tenant) right after a TRUTHFUL ready flip", async () => {
    const swap = vi.fn().mockResolvedValue(undefined);
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "tsw", external_ref: { render_service_id: "srv_sw" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://tsw.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
      swapPreviewOnReady: swap,
    });
    const r = await pollDeployStatuses(d);
    expect(d.setStatus).toHaveBeenCalledWith("tsw", "ready", expect.objectContaining({ url: "https://tsw.onrender.com" }));
    expect(swap).toHaveBeenCalledWith("tsw");
    expect(r).toMatchObject({ ready: 1 });
  });

  it("SWAP: does NOT call swapPreviewOnReady when the row never reaches ready (false-live)", async () => {
    const swap = vi.fn().mockResolvedValue(undefined);
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "tns", external_ref: { render_service_id: "srv_ns" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://tns.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(false),
      swapPreviewOnReady: swap,
    });
    await pollDeployStatuses(d);
    expect(swap).not.toHaveBeenCalled();
  });

  it("SWAP: a swap throw never undoes the ready flip (row still ready)", async () => {
    const swap = vi.fn().mockRejectedValue(new Error("reap failed"));
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "tth", external_ref: { render_service_id: "srv_th" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://tth.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
      swapPreviewOnReady: swap,
    });
    const r = await pollDeployStatuses(d);
    expect(d.setStatus).toHaveBeenCalledWith("tth", "ready", expect.any(Object));
    expect(r).toMatchObject({ ready: 1 });
  });
});

describe("reconcileFailedRow (FIX B — monotonic failed→ready recovery)", () => {
  function fdeps(over: Partial<DeployPollDeps> = {}): DeployPollDeps & {
    fetchServiceUrl: ReturnType<typeof vi.fn>;
    probeLiveness: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    bumpProvisioning: ReturnType<typeof vi.fn>;
  } {
    return {
      loadProvisioningHosting: vi.fn().mockResolvedValue([]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue(null),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://x.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn().mockResolvedValue(undefined),
      bumpProvisioning: vi.fn().mockResolvedValue(undefined),
      ...over,
    } as DeployPollDeps & {
      fetchServiceUrl: ReturnType<typeof vi.fn>;
      probeLiveness: ReturnType<typeof vi.fn>;
      setStatus: ReturnType<typeof vi.fn>;
      bumpProvisioning: ReturnType<typeof vi.fn>;
    };
  }

  it("flips failed→ready on a 2xx with the re-fetched URL + recovered_from_failed marker", async () => {
    const d = fdeps({
      fetchServiceUrl: vi.fn().mockResolvedValue("https://recovered.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
    });
    const recovered = await reconcileFailedRow(
      d,
      { tenant_id: "tf1", external_ref: { render_service_id: "srv_f1" } },
      "srv_f1",
    );
    expect(recovered).toBe(true);
    expect(d.fetchServiceUrl).toHaveBeenCalledWith("srv_f1");
    expect(d.probeLiveness).toHaveBeenCalledWith("https://recovered.onrender.com");
    expect(d.setStatus).toHaveBeenCalledWith("tf1", "ready", {
      render_service_id: "srv_f1",
      url: "https://recovered.onrender.com",
      recovered_from_failed: true,
    });
    expect(d.bumpProvisioning).not.toHaveBeenCalled();
  });

  it("STAYS failed on a non-2xx probe — no setStatus, no bump", async () => {
    const d = fdeps({
      fetchServiceUrl: vi.fn().mockResolvedValue("https://stillbroken.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(false),
    });
    const recovered = await reconcileFailedRow(
      d,
      { tenant_id: "tf2", external_ref: { render_service_id: "srv_f2" } },
      "srv_f2",
    );
    expect(recovered).toBe(false);
    expect(d.setStatus).not.toHaveBeenCalled();
    expect(d.bumpProvisioning).not.toHaveBeenCalled();
  });

  it("STAYS failed when the URL is null — never probes", async () => {
    const d = fdeps({
      fetchServiceUrl: vi.fn().mockResolvedValue(null),
      probeLiveness: vi.fn().mockResolvedValue(true),
    });
    const recovered = await reconcileFailedRow(
      d,
      { tenant_id: "tf3", external_ref: { render_service_id: "srv_f3" } },
      "srv_f3",
    );
    expect(recovered).toBe(false);
    expect(d.probeLiveness).not.toHaveBeenCalled();
    expect(d.setStatus).not.toHaveBeenCalled();
    expect(d.bumpProvisioning).not.toHaveBeenCalled();
  });

  it("idempotent re-flip is harmless (a second recovery just re-asserts ready)", async () => {
    const d = fdeps({
      fetchServiceUrl: vi.fn().mockResolvedValue("https://idem.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
    });
    const row = { tenant_id: "tf4", external_ref: { render_service_id: "srv_f4" } };
    const a = await reconcileFailedRow(d, row, "srv_f4");
    const b = await reconcileFailedRow(d, row, "srv_f4");
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(d.setStatus).toHaveBeenCalledTimes(2);
    expect(d.setStatus).toHaveBeenLastCalledWith("tf4", "ready", {
      render_service_id: "srv_f4",
      url: "https://idem.onrender.com",
      recovered_from_failed: true,
    });
  });
});

describe("pollDeployStatuses — failed-recovery loop (FIX B, default ON; kill-switch ='0')", () => {
  const SAVED = process.env.BUILD_DEPLOY_STAGE_ENABLED;
  afterEach(() => {
    if (SAVED === undefined) delete process.env.BUILD_DEPLOY_STAGE_ENABLED;
    else process.env.BUILD_DEPLOY_STAGE_ENABLED = SAVED;
  });

  function rdeps(over: Partial<DeployPollDeps> = {}): DeployPollDeps & {
    loadProvisioningHosting: ReturnType<typeof vi.fn>;
    loadRecentFailedHosting: ReturnType<typeof vi.fn>;
    fetchServiceUrl: ReturnType<typeof vi.fn>;
    probeLiveness: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  } {
    return {
      loadProvisioningHosting: vi.fn().mockResolvedValue([]),
      loadRecentFailedHosting: vi.fn().mockResolvedValue([]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue(null),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://x.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn().mockResolvedValue(undefined),
      bumpProvisioning: vi.fn().mockResolvedValue(undefined),
      ...over,
    } as DeployPollDeps & {
      loadProvisioningHosting: ReturnType<typeof vi.fn>;
      loadRecentFailedHosting: ReturnType<typeof vi.fn>;
      fetchServiceUrl: ReturnType<typeof vi.fn>;
      probeLiveness: ReturnType<typeof vi.fn>;
      setStatus: ReturnType<typeof vi.fn>;
    };
  }

  it("kill-switch ='0' → never runs the failed loop (loadRecentFailedHosting untouched), recovered:0", async () => {
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "0";
    const d = rdeps({
      loadRecentFailedHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "tf", external_ref: { render_service_id: "srv_f" } }]),
    });
    const r = await pollDeployStatuses(d);
    expect(d.loadRecentFailedHosting).not.toHaveBeenCalled();
    expect(d.setStatus).not.toHaveBeenCalled();
    expect(r.recovered).toBe(0);
  });

  it("default ON (env unset) → runs the failed loop", async () => {
    delete process.env.BUILD_DEPLOY_STAGE_ENABLED;
    const d = rdeps({
      loadRecentFailedHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "tf", external_ref: { render_service_id: "srv_f" } }]),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://up.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
    });
    const r = await pollDeployStatuses(d);
    expect(d.loadRecentFailedHosting).toHaveBeenCalledOnce();
    expect(r.recovered).toBe(1);
  });

  it("flag ON → runs the failed loop and counts `recovered` separately from `ready`", async () => {
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "1";
    const d = rdeps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "tp", external_ref: { render_service_id: "srv_p" } }]),
      loadRecentFailedHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "tf", external_ref: { render_service_id: "srv_f" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://up.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
    });
    const r = await pollDeployStatuses(d);
    expect(d.loadRecentFailedHosting).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ ready: 1, recovered: 1 });
    expect(d.setStatus).toHaveBeenCalledWith("tf", "ready", {
      render_service_id: "srv_f",
      url: "https://up.onrender.com",
      recovered_from_failed: true,
    });
  });

  it("flag ON, failed row still not live → recovered:0, no setStatus on the failed row", async () => {
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "1";
    const d = rdeps({
      loadRecentFailedHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "tf", external_ref: { render_service_id: "srv_f" } }]),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://down.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(false),
    });
    const r = await pollDeployStatuses(d);
    expect(r.recovered).toBe(0);
    expect(d.setStatus).not.toHaveBeenCalled();
  });

  it("flag ON → skips a failed row with no render_service_id", async () => {
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "1";
    const d = rdeps({
      loadRecentFailedHosting: vi.fn().mockResolvedValue([{ tenant_id: "tf", external_ref: {} }]),
    });
    const r = await pollDeployStatuses(d);
    expect(d.fetchServiceUrl).not.toHaveBeenCalled();
    expect(d.setStatus).not.toHaveBeenCalled();
    expect(r.recovered).toBe(0);
  });

  it("flag ON but loadRecentFailedHosting absent → no failed loop, recovered:0", async () => {
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "1";
    const d = rdeps({ loadRecentFailedHosting: undefined });
    const r = await pollDeployStatuses(d);
    expect(r.recovered).toBe(0);
  });
});

describe("product_url is written at the TRUTHFUL ready flip", () => {
  it("writes the probe-verified URL as product_url when hosting flips to ready", async () => {
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "1";
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "t1", external_ref: { render_service_id: "srv-1" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://dance-ai-6e58.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
    });

    await pollDeployStatuses(d);

    expect(d.setStatus).toHaveBeenCalledWith("t1", "ready", expect.anything());
    expect(d.setProductUrl).toHaveBeenCalledWith("t1", "https://dance-ai-6e58.onrender.com");
  });

  it("NEVER writes product_url when the app is not proven live (2xx probe fails)", async () => {
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "1";
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "t1", external_ref: { render_service_id: "srv-1" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://dead.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(false),
    });

    await pollDeployStatuses(d);

    expect(d.setProductUrl).not.toHaveBeenCalled();
  });

  it("a product_url write failure NEVER undoes a verified-live ready flip", async () => {
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "1";
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "t1", external_ref: { render_service_id: "srv-1" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://ok.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
      setProductUrl: vi.fn().mockRejectedValue(new Error("23502 boom")),
    });

    const r = await pollDeployStatuses(d);

    expect(d.setStatus).toHaveBeenCalledWith("t1", "ready", expect.anything());
    expect(r.ready).toBe(1);
  });
});

describe("product_url is ONLY written for tenants whose product IS the app we built", () => {
  it("does NOT overwrite a real company's identity with a Zavi-built test app (the upcar-ai case)", async () => {
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "upcar-ai", external_ref: { render_service_id: "srv-1" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://handyhub-6ec4d609.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
      isBuildFlowTenant: vi.fn().mockResolvedValue(false),
    });

    const r = await pollDeployStatuses(d);

    expect(d.setProductUrl).not.toHaveBeenCalled();
    expect(d.setStatus).toHaveBeenCalledWith("upcar-ai", "ready", expect.anything());
    expect(r.ready).toBe(1);
  });

  it("FAILS CLOSED — if we cannot confirm the tenant is build-flow, we do not touch their identity", async () => {
    const d = deps({
      loadProvisioningHosting: vi
        .fn()
        .mockResolvedValue([{ tenant_id: "t-unknown", external_ref: { render_service_id: "srv-1" } }]),
      fetchLatestDeployStatus: vi.fn().mockResolvedValue("live"),
      fetchServiceUrl: vi.fn().mockResolvedValue("https://x.onrender.com"),
      probeLiveness: vi.fn().mockResolvedValue(true),
      isBuildFlowTenant: vi.fn().mockRejectedValue(new Error("settings read blew up")),
    });

    await pollDeployStatuses(d);

    expect(d.setProductUrl).not.toHaveBeenCalled();
  });
});
