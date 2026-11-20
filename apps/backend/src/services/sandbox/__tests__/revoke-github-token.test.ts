import { describe, it, expect, vi, beforeEach } from "vitest";

const { write, run, connect } = vi.hoisted(() => {
  const write = vi.fn(async () => {});
  const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
  const connect = vi.fn(async () => ({ files: { write }, commands: { run } }));
  return { write, run, connect };
});
vi.mock("e2b", () => ({ Sandbox: { connect } }));

import {
  stripOriginTokenStep,
  revokeSandboxGithubToken,
} from "../e2b-client";

describe("stripOriginTokenStep — no baked secret", () => {
  it("bakes in NO literal token (only the placeholder + shell interpolation)", () => {
    const step = stripOriginTokenStep();
    expect(step).not.toMatch(/ghs_[A-Za-z0-9]{20,}/);
    expect(step).not.toMatch(/x-access-token:(?!REVOKED@)[A-Za-z0-9]{20,}@/);
  });
});

describe("revokeSandboxGithubToken — behavior", () => {
  beforeEach(() => {
    write.mockClear();
    run.mockClear();
    connect.mockClear();
    process.env.E2B_API_KEY = "test-key";
  });

  it("rewrites .praxis-env WITHOUT the token but KEEPS NODE_OPTIONS", async () => {
    await revokeSandboxGithubToken("sbx_1", {
      NODE_OPTIONS: "--max-old-space-size=6144",
    });
    expect(write).toHaveBeenCalledTimes(1);
    const [path, content] = write.mock.calls[0] as unknown as [string, string];
    expect(path).toBe("/home/user/.praxis-env");
    expect(content).toContain("NODE_OPTIONS");
    expect(content).not.toContain("GITHUB_TOKEN");
    expect(content).not.toMatch(/ghs_/);
  });

  it("issues the remote-URL strip command", async () => {
    await revokeSandboxGithubToken("sbx_1", {
      NODE_OPTIONS: "--max-old-space-size=6144",
    });
    expect(run).toHaveBeenCalledTimes(1);
    const [cmd] = run.mock.calls[0] as unknown as [string, unknown];
    expect(cmd).toContain(stripOriginTokenStep());
  });

  it("throws when the remote-URL scrub exits non-zero (the token would stay in the remote)", async () => {
    run.mockResolvedValueOnce({ stdout: "", stderr: "fatal: not a git repository", exitCode: 128 });
    await expect(revokeSandboxGithubToken("sbx_1")).rejects.toThrow(/scrub failed \(exit 128\)/);
  });

  it("throws when the scrub command itself fails to run", async () => {
    run.mockRejectedValueOnce(Object.assign(new Error("boom"), { exitCode: 1 }));
    await expect(revokeSandboxGithubToken("sbx_1")).rejects.toThrow(/scrub failed/);
  });

  it("empty keepEnv → env file carries no token at all", async () => {
    await revokeSandboxGithubToken("sbx_1");
    const [, content] = write.mock.calls[0] as unknown as [string, string];
    expect(content).not.toContain("GITHUB_TOKEN");
    expect(content).not.toMatch(/ghs_/);
  });
});
