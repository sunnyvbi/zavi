import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  wipeSandboxSecretsMock,
  extendSandboxTimeoutMock,
  pauseAndMarkPausedMock,
  getKeepaliveMock,
} = vi.hoisted(() => ({
  wipeSandboxSecretsMock: vi.fn(async () => undefined),
  extendSandboxTimeoutMock: vi.fn(async () => undefined),
  pauseAndMarkPausedMock: vi.fn(async () => undefined),
  getKeepaliveMock: vi.fn(async (_t: string) => false),
}));

vi.mock("@/services/sandbox/lifecycle", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/sandbox/lifecycle")
  >("@/services/sandbox/lifecycle");
  return {
    ...actual,
    wipeSandboxSecrets: wipeSandboxSecretsMock,
    pauseAndMarkPaused: pauseAndMarkPausedMock,
  };
});

vi.mock("@/services/sandbox/e2b-client", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/sandbox/e2b-client")
  >("@/services/sandbox/e2b-client");
  return {
    ...actual,
    extendSandboxTimeout: extendSandboxTimeoutMock,
    revokeSandboxGithubToken: wipeSandboxSecretsMock,
  };
});

vi.mock("@/services/sandbox/keepalive-flag", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/sandbox/keepalive-flag")
  >("@/services/sandbox/keepalive-flag");
  return {
    ...actual,
    getTenantSandboxKeepalive: getKeepaliveMock,
  };
});

import { pauseAndMarkPaused } from "@/services/sandbox/lifecycle";
import { extendSandboxTimeout, revokeSandboxGithubToken } from "@/services/sandbox/e2b-client";
import { getTenantSandboxKeepalive } from "@/services/sandbox/keepalive-flag";

const sandbox = {
  row_id: "row-1",
  e2b_sandbox_id: "sbx-1",
};

beforeEach(() => {
  wipeSandboxSecretsMock.mockClear();
  extendSandboxTimeoutMock.mockClear();
  pauseAndMarkPausedMock.mockClear();
  getKeepaliveMock.mockReset();
});

async function teardown(tenant_id: string) {
  await revokeSandboxGithubToken(sandbox.e2b_sandbox_id);
  const keepalive = await getTenantSandboxKeepalive(tenant_id);
  if (keepalive) {
    try {
      await extendSandboxTimeout(sandbox.e2b_sandbox_id);
    } catch {
      await pauseAndMarkPaused(sandbox);
    }
  } else {
    await pauseAndMarkPaused(sandbox);
  }
}

describe("run-agent finally — branch shape under keepalive", () => {
  it("flag=true: wipeSecrets called, extendTimeout called, pauseAndMark NOT called", async () => {
    getKeepaliveMock.mockResolvedValueOnce(true);
    await teardown("tenant-A");

    expect(wipeSandboxSecretsMock).toHaveBeenCalledTimes(1);
    expect(extendSandboxTimeoutMock).toHaveBeenCalledTimes(1);
    expect(pauseAndMarkPausedMock).not.toHaveBeenCalled();
  });

  it("flag=false: wipeSecrets called, pauseAndMark called, extendTimeout NOT called (regression guard)", async () => {
    getKeepaliveMock.mockResolvedValueOnce(false);
    await teardown("tenant-A");

    expect(wipeSandboxSecretsMock).toHaveBeenCalledTimes(1);
    expect(pauseAndMarkPausedMock).toHaveBeenCalledTimes(1);
    expect(extendSandboxTimeoutMock).not.toHaveBeenCalled();
  });

  it("flag=true + extendTimeout throws: falls back to pauseAndMark", async () => {
    getKeepaliveMock.mockResolvedValueOnce(true);
    extendSandboxTimeoutMock.mockRejectedValueOnce(new Error("e2b api down"));

    await teardown("tenant-A");

    expect(wipeSandboxSecretsMock).toHaveBeenCalledTimes(1);
    expect(extendSandboxTimeoutMock).toHaveBeenCalledTimes(1);
    expect(pauseAndMarkPausedMock).toHaveBeenCalledTimes(1);
  });
});
