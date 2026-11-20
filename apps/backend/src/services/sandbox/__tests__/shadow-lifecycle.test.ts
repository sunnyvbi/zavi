import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  createSandbox,
  setEnv,
  cloneRepo,
  destroySandbox,
  resolveRepoCredsForRun,
  getSandboxIdForRun,
} = vi.hoisted(() => ({
  createSandbox: vi.fn(async () => "sbx_shadow_fresh"),
  setEnv: vi.fn(async () => {}),
  cloneRepo: vi.fn(async () => ({ stdout: "", stderr: "", exit_code: 0, ms: 5 })),
  destroySandbox: vi.fn(async () => {}),
  resolveRepoCredsForRun: vi.fn(async () => ({
    kind: "resolved" as const,
    owner: "rravi149",
    repo: "praxis",
    repo_full_name: "rravi149/praxis",
    installation_token: "ghs_shadowtoken",
  })),
  getSandboxIdForRun: vi.fn(async () => {
    throw new Error("getSandboxIdForRun MUST NOT be called on a shadow path");
  }),
}));

vi.mock("../e2b-client", () => ({
  createSandbox,
  setEnv,
  cloneRepo,
  destroySandbox,
}));

vi.mock("../repo-creds", () => ({
  resolveRepoCredsForRun,
}));

vi.mock("../lifecycle", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSandboxIdForRun };
});

import {
  createShadowSandboxForRun,
  destroyShadowSandbox,
  resolveShadowOrLiveSandboxId,
  ShadowSandboxProvisionError,
} from "../shadow-lifecycle";

beforeEach(() => {
  createSandbox.mockClear();
  setEnv.mockClear();
  cloneRepo.mockClear();
  destroySandbox.mockClear();
  resolveRepoCredsForRun.mockClear();
  getSandboxIdForRun.mockClear();
  createSandbox.mockResolvedValue("sbx_shadow_fresh");
  cloneRepo.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0, ms: 5 });
  resolveRepoCredsForRun.mockResolvedValue({
    kind: "resolved",
    owner: "rravi149",
    repo: "praxis",
    repo_full_name: "rravi149/praxis",
    installation_token: "ghs_shadowtoken",
  });
});

describe("createShadowSandboxForRun — provisioning", () => {
  it("mints creds (worker resolver) → createSandbox → setEnv(GITHUB_TOKEN) → cloneRepo, returns the fresh handle", async () => {
    const handle = await createShadowSandboxForRun({
      run_id: "run_1",
      tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
      payload: { repo_hint: "rravi149/praxis" },
    });

    expect(handle).toEqual({
      sandbox_id: "sbx_shadow_fresh",
      repo_full_name: "rravi149/praxis",
    });

    expect(resolveRepoCredsForRun).toHaveBeenCalledTimes(1);
    expect(resolveRepoCredsForRun).toHaveBeenCalledWith(
      "73db45ff-457e-4541-bc8f-bdb625390204",
      { repo_hint: "rravi149/praxis" },
    );

    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(createSandbox).toHaveBeenCalledWith({
      tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
      repo_full_name: "rravi149/praxis",
    });

    expect(setEnv).toHaveBeenCalledTimes(1);
    expect(setEnv).toHaveBeenCalledWith("sbx_shadow_fresh", {
      GITHUB_TOKEN: "ghs_shadowtoken",
    });
    expect(cloneRepo).toHaveBeenCalledTimes(1);
    expect(cloneRepo).toHaveBeenCalledWith("sbx_shadow_fresh", "rravi149", "praxis");
  });

  it("NEVER calls getSandboxIdForRun and NEVER reads/writes tenant_sandbox", async () => {
    await createShadowSandboxForRun({
      run_id: "run_1",
      tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
      payload: {},
    });
    expect(getSandboxIdForRun).not.toHaveBeenCalled();
  });

  it("orders create → setEnv → clone (token written before clone reads it)", async () => {
    const order: string[] = [];
    createSandbox.mockImplementation(async () => {
      order.push("create");
      return "sbx_shadow_fresh";
    });
    setEnv.mockImplementation(async () => {
      order.push("setEnv");
    });
    cloneRepo.mockImplementation(async () => {
      order.push("clone");
      return { stdout: "", stderr: "", exit_code: 0, ms: 5 };
    });
    await createShadowSandboxForRun({ run_id: "r", tenant_id: "t", payload: {} });
    expect(order).toEqual(["create", "setEnv", "clone"]);
  });

  it("fail-closed: needs_pick creds → throws, no sandbox created", async () => {
    resolveRepoCredsForRun.mockResolvedValue({
      kind: "needs_pick",
      repos: ["a/b", "c/d"],
    } as never);
    await expect(
      createShadowSandboxForRun({ run_id: "r", tenant_id: "t", payload: {} }),
    ).rejects.toBeInstanceOf(ShadowSandboxProvisionError);
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("clone failure: error PROPAGATES and carries the half-created sandbox_id for teardown", async () => {
    cloneRepo.mockResolvedValue({
      stdout: "",
      stderr: "fatal: repository not found",
      exit_code: 128,
      ms: 10,
    });

    let caught: unknown;
    let handle: { sandbox_id: string } | undefined;
    try {
      handle = await createShadowSandboxForRun({
        run_id: "r",
        tenant_id: "t",
        payload: {},
      });
    } catch (e) {
      caught = e;
    } finally {
      const sbId =
        (handle as { sandbox_id?: string } | undefined)?.sandbox_id ??
        (caught as ShadowSandboxProvisionError | undefined)?.sandbox_id;
      await destroyShadowSandbox(sbId);
    }

    expect(caught).toBeInstanceOf(ShadowSandboxProvisionError);
    expect((caught as ShadowSandboxProvisionError).sandbox_id).toBe(
      "sbx_shadow_fresh",
    );
    expect(destroySandbox).toHaveBeenCalledTimes(1);
    expect(destroySandbox).toHaveBeenCalledWith("sbx_shadow_fresh");
  });
});

describe("destroyShadowSandbox — unconditional teardown", () => {
  it("calls destroySandbox unconditionally for a real id", async () => {
    await destroyShadowSandbox("sbx_x");
    expect(destroySandbox).toHaveBeenCalledTimes(1);
    expect(destroySandbox).toHaveBeenCalledWith("sbx_x");
  });

  it("is a no-op for a null/undefined id (handle never created)", async () => {
    await destroyShadowSandbox(null);
    await destroyShadowSandbox(undefined);
    expect(destroySandbox).not.toHaveBeenCalled();
  });

  it("swallows a teardown failure (never throws out of the caller's finally)", async () => {
    destroySandbox.mockRejectedValueOnce(new Error("e2b kill 500"));
    await expect(destroyShadowSandbox("sbx_x")).resolves.toBeUndefined();
  });
});

describe("resolveShadowOrLiveSandboxId — resolver branch", () => {
  it("SHADOW: returns ctx.shadow_sandbox_id WITHOUT touching the live resolver", async () => {
    const resolveLive = vi.fn(async () => "sbx_LIVE_singleton");
    const id = await resolveShadowOrLiveSandboxId(
      { shadow_mode: true, shadow_sandbox_id: "sbx_shadow_fresh" },
      resolveLive,
    );
    expect(id).toBe("sbx_shadow_fresh");
    expect(resolveLive).not.toHaveBeenCalled();
  });

  it("SHADOW + missing shadow_sandbox_id: FAILS CLOSED (throws, never falls back to live)", async () => {
    const resolveLive = vi.fn(async () => "sbx_LIVE_singleton");
    await expect(
      resolveShadowOrLiveSandboxId({ shadow_mode: true }, resolveLive),
    ).rejects.toThrow(/refusing to fall back to the live tenant_sandbox/i);
    expect(resolveLive).not.toHaveBeenCalled();
  });

  it("LIVE: delegates to the injected live resolver (path unchanged)", async () => {
    const resolveLive = vi.fn(async () => "sbx_LIVE_singleton");
    const id = await resolveShadowOrLiveSandboxId({}, resolveLive);
    expect(id).toBe("sbx_LIVE_singleton");
    expect(resolveLive).toHaveBeenCalledTimes(1);
  });

  it("LIVE: throws the same 'no active sandbox' shape when live resolution returns null", async () => {
    const resolveLive = vi.fn(async () => null);
    await expect(
      resolveShadowOrLiveSandboxId({}, resolveLive),
    ).rejects.toThrow(/no active sandbox/i);
  });
});
