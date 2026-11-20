
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  cap: 50,
  creds: {
    kind: "resolved" as const,
    owner: "acme",
    repo: "app",
    repo_full_name: "acme/app",
    installation_token: "ghs_TOKEN",
    provisioned: false,
  } as
    | {
        kind: "resolved";
        owner: string;
        repo: string;
        repo_full_name: string;
        installation_token: string;
        provisioned: boolean;
      }
    | { kind: "needs_pick"; repos: string[] },
  resolveSandboxThrows: false,
  settingValue: [] as unknown,
}));

vi.mock("@/services/settings", () => ({
  getNumberSetting: vi.fn(async () => H.cap),
  getSetting: vi.fn(async () => H.settingValue),
}));

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async () => undefined),
}));

vi.mock("../repo-creds", () => ({
  resolveRepoCredsForRun: vi.fn(async () => H.creds),
}));

vi.mock("../lifecycle", () => ({
  resolveSandboxForRun: vi.fn(async () => {
    if (H.resolveSandboxThrows) throw new Error("e2b connect timeout");
    return { row_id: "row-1", e2b_sandbox_id: "sbx-lazy-1" };
  }),
  injectSandboxSecrets: vi.fn(async () => undefined),
  bootstrapRepoIfNeeded: vi.fn(async () => undefined),
}));

import {
  lazyProvisionSandboxForRun,
  LazyProvisionError,
  takeLazyProvisionedSandbox,
  lazyProvisionCountToday,
  _resetLazyProvisionCounts,
  _resetLazyProvisionedHandles,
} from "../lazy-provision";
import { resolveSandboxMode } from "../sandbox-enablement-flag";
import { injectSandboxSecrets, resolveSandboxForRun } from "../lifecycle";
import { resolveRepoCredsForRun } from "../repo-creds";

const injectMock = vi.mocked(injectSandboxSecrets);
const resolveSandboxMock = vi.mocked(resolveSandboxForRun);
const credsMock = vi.mocked(resolveRepoCredsForRun);

const TENANT = "11111111-1111-1111-1111-111111111111";
const baseArgs = {
  tenant_id: TENANT,
  run_id: "run-1",
  agent_slug: "pm",
  repo_full_name: "acme/app",
  payload: { repo_hint: "acme/app" },
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetLazyProvisionCounts();
  _resetLazyProvisionedHandles();
  H.cap = 50;
  H.creds = {
    kind: "resolved",
    owner: "acme",
    repo: "app",
    repo_full_name: "acme/app",
    installation_token: "ghs_TOKEN",
    provisioned: false,
  };
  H.resolveSandboxThrows = false;
  H.settingValue = [];
  resolveSandboxMock.mockImplementation(async () => {
    if (H.resolveSandboxThrows) throw new Error("e2b connect timeout");
    return { row_id: "row-1", e2b_sandbox_id: "sbx-lazy-1" };
  });
});

describe("lazyProvisionSandboxForRun", () => {
  it("provisions on first call, injects ONLY GITHUB_TOKEN, registers the handle + bumps the count", async () => {
    const id = await lazyProvisionSandboxForRun(baseArgs);
    expect(id).toBe("sbx-lazy-1");

    expect(injectMock).toHaveBeenCalledTimes(1);
    const injectedSecrets = injectMock.mock.calls[0][1];
    expect(Object.keys(injectedSecrets)).toEqual(["GITHUB_TOKEN"]);
    expect(injectedSecrets.GITHUB_TOKEN).toBe("ghs_TOKEN");

    const adopted = takeLazyProvisionedSandbox("run-1");
    expect(adopted?.handle.e2b_sandbox_id).toBe("sbx-lazy-1");
    expect(adopted?.repo_full_name).toBe("acme/app");
    expect(takeLazyProvisionedSandbox("run-1")).toBeNull();

    expect(lazyProvisionCountToday(TENANT)).toBe(1);
  });

  it("cost-cap exhaustion → non-retryable deny, WITHOUT touching e2b", async () => {
    H.cap = 1;
    await lazyProvisionSandboxForRun({ ...baseArgs, run_id: "run-a" });
    expect(lazyProvisionCountToday(TENANT)).toBe(1);

    resolveSandboxMock.mockClear();
    await expect(
      lazyProvisionSandboxForRun({ ...baseArgs, run_id: "run-b" }),
    ).rejects.toMatchObject({
      name: "LazyProvisionError",
      code: "sandbox_daily_cap_exhausted",
      retryable: false,
    });
    expect(resolveSandboxMock).not.toHaveBeenCalled();
  });

  it("cap=0 means uncapped", async () => {
    H.cap = 0;
    for (let i = 0; i < 5; i++) {
      await lazyProvisionSandboxForRun({ ...baseArgs, run_id: `run-${i}` });
    }
    expect(lazyProvisionCountToday(TENANT)).toBe(5);
  });

  it("transient failure → RETRYABLE LazyProvisionError, count NOT burned, no handle registered", async () => {
    H.resolveSandboxThrows = true;
    await expect(lazyProvisionSandboxForRun(baseArgs)).rejects.toMatchObject({
      name: "LazyProvisionError",
      code: "sandbox_provision_failed",
      retryable: true,
    });
    expect(lazyProvisionCountToday(TENANT)).toBe(0);
    expect(takeLazyProvisionedSandbox("run-1")).toBeNull();

    H.resolveSandboxThrows = false;
    const id = await lazyProvisionSandboxForRun(baseArgs);
    expect(id).toBe("sbx-lazy-1");
    expect(lazyProvisionCountToday(TENANT)).toBe(1);
  });

  it("repo mismatch between resolved creds and the pinned repo → non-retryable deny", async () => {
    H.creds = {
      kind: "resolved",
      owner: "acme",
      repo: "other",
      repo_full_name: "acme/other",
      installation_token: "ghs_TOKEN",
      provisioned: false,
    };
    await expect(lazyProvisionSandboxForRun(baseArgs)).rejects.toMatchObject({
      name: "LazyProvisionError",
      code: "repo_mismatch",
      retryable: false,
    });
    expect(resolveSandboxMock).not.toHaveBeenCalled();
  });

  it("needs_pick creds → non-retryable deny (no ambiguous provision)", async () => {
    H.creds = { kind: "needs_pick", repos: ["acme/app", "acme/other"] };
    await expect(lazyProvisionSandboxForRun(baseArgs)).rejects.toMatchObject({
      name: "LazyProvisionError",
      code: "repo_unresolved",
      retryable: false,
    });
  });

  it("FIX #2: N concurrent provisions with cap=1 → exactly ONE succeeds, the rest get cap-exhausted (no fail-open)", async () => {
    H.cap = 1;
    resolveSandboxMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { row_id: "row-1", e2b_sandbox_id: "sbx-lazy-1" };
    });

    const N = 8;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        lazyProvisionSandboxForRun({ ...baseArgs, run_id: `run-${i}` }),
      ),
    );

    const ok = results.filter((r) => r.status === "fulfilled");
    const denied = results.filter(
      (r) =>
        r.status === "rejected" &&
        (r.reason as LazyProvisionError).code === "sandbox_daily_cap_exhausted",
    );
    expect(ok).toHaveLength(1);
    expect(denied).toHaveLength(N - 1);
    expect(lazyProvisionCountToday(TENANT)).toBe(1);
    expect(resolveSandboxMock).toHaveBeenCalledTimes(1);
  });

  it("FIX #2: a transient failure ROLLS BACK its reservation so a later run can still take the slot", async () => {
    H.cap = 1;
    H.resolveSandboxThrows = true;
    await expect(
      lazyProvisionSandboxForRun({ ...baseArgs, run_id: "run-fail" }),
    ).rejects.toMatchObject({ code: "sandbox_provision_failed", retryable: true });
    expect(lazyProvisionCountToday(TENANT)).toBe(0);

    H.resolveSandboxThrows = false;
    const id = await lazyProvisionSandboxForRun({ ...baseArgs, run_id: "run-ok" });
    expect(id).toBe("sbx-lazy-1");
    expect(lazyProvisionCountToday(TENANT)).toBe(1);
  });

  it("FIX #2: a hard validation deny (repo_mismatch) also rolls back its reservation", async () => {
    H.cap = 1;
    H.creds = {
      kind: "resolved",
      owner: "acme",
      repo: "other",
      repo_full_name: "acme/other",
      installation_token: "ghs_TOKEN",
      provisioned: false,
    };
    await expect(lazyProvisionSandboxForRun(baseArgs)).rejects.toMatchObject({
      code: "repo_mismatch",
    });
    expect(lazyProvisionCountToday(TENANT)).toBe(0);
  });

  it("FIX #1: takeLazyProvisionedSandbox is flag-INDEPENDENT — the worker finally can adopt+teardown a drifted lazy box", async () => {
    await lazyProvisionSandboxForRun({ ...baseArgs, run_id: "drift-run" });
    const adopted = takeLazyProvisionedSandbox("drift-run");
    expect(adopted).not.toBeNull();
    expect(adopted!.handle.e2b_sandbox_id).toBe("sbx-lazy-1");
  });

  it("LazyProvisionError is a real Error subclass (so the handler try/catch surfaces .message)", async () => {
    H.cap = 0;
    H.resolveSandboxThrows = true;
    try {
      await lazyProvisionSandboxForRun(baseArgs);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LazyProvisionError);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain("retry");
    }
    expect(credsMock).toHaveBeenCalled();
  });
});

describe("resolveSandboxMode — eager vs lazy vs default classification", () => {
  const agent = (slug: string, requires_sandbox: boolean) => ({
    slug,
    metadata_praxis: { requires_sandbox },
  });

  it("engineer (frontmatter true) → eager, NOT lazy (eager path byte-identical)", async () => {
    H.settingValue = [];
    const r = await resolveSandboxMode(agent("engineer", true), TENANT);
    expect(r).toEqual({ requires_sandbox: true, lazyEligible: false });
  });

  it("default flag empty + non-engineer → no sandbox, not lazy (byte-identical to today)", async () => {
    H.settingValue = [];
    const r = await resolveSandboxMode(agent("pm", false), TENANT);
    expect(r).toEqual({ requires_sandbox: false, lazyEligible: false });
  });

  it("flag-promoted non-engineer → requires_sandbox true AND lazyEligible true", async () => {
    H.settingValue = ["pm"];
    const r = await resolveSandboxMode(agent("pm", false), TENANT);
    expect(r).toEqual({ requires_sandbox: true, lazyEligible: true });
  });

  it("denylisted agent (operator) is never promoted, even if allowlisted", async () => {
    H.settingValue = ["operator"];
    const r = await resolveSandboxMode(agent("operator", false), TENANT);
    expect(r).toEqual({ requires_sandbox: false, lazyEligible: false });
  });

  it("WILDCARD ['*'] → non-engineer is requires_sandbox true AND lazyEligible true", async () => {
    H.settingValue = ["*"];
    const r = await resolveSandboxMode(agent("pm", false), TENANT);
    expect(r).toEqual({ requires_sandbox: true, lazyEligible: true });
  });

  it("WILDCARD ['*'] → engineer stays EAGER (lazyEligible false; base frontmatter true)", async () => {
    H.settingValue = ["*"];
    const r = await resolveSandboxMode(agent("engineer", true), TENANT);
    expect(r).toEqual({ requires_sandbox: true, lazyEligible: false });
  });

  it("WILDCARD ['*'] → denylisted operator NOT eligible (denylist beats the wildcard)", async () => {
    H.settingValue = ["*"];
    const r = await resolveSandboxMode(agent("operator", false), TENANT);
    expect(r).toEqual({ requires_sandbox: false, lazyEligible: false });
  });
});
