
import { execFileSync } from "node:child_process";
import { describe, it, expect, vi, beforeEach } from "vitest";

const run = vi.fn();
vi.mock("e2b", () => ({
  Sandbox: { connect: vi.fn(async () => ({ commands: { run } })) },
}));

import { execCommand, assertAllowlistedEnvKeys } from "../e2b-client";

const LINK = "https://ref.supabase.co/auth/v1/verify?token=SECRET-MAGIC-TOKEN-123";

beforeEach(() => {
  run.mockReset();
  process.env.E2B_API_KEY = "test-key";
});

describe("execCommand env option", () => {
  it("passes env to the process, never into the command string", async () => {
    run.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    await execCommand("sbx", "npm run smoke", 60_000, { env: { SMOKE_OWNER_LINK: LINK, SMOKE_BASE_URL: "https://a.b" } });
    const [cmd, opts] = run.mock.calls[0];
    expect(cmd).not.toContain(LINK);
    expect(cmd).not.toContain("SECRET-MAGIC");
    expect(cmd).toContain("npm run smoke");
    expect(opts).toMatchObject({ timeoutMs: 60_000, envs: { SMOKE_OWNER_LINK: LINK, SMOKE_BASE_URL: "https://a.b" } });
  });

  it("redacts env values and explicit redact strings from stdout and stderr", async () => {
    run.mockResolvedValue({ exitCode: 0, stdout: `visiting ${LINK} now`, stderr: `extra-secret-value in stderr` });
    const r = await execCommand("sbx", "x", 1000, { env: { SMOKE_OWNER_LINK: LINK }, redact: ["extra-secret-value"] });
    expect(r.stdout).toBe("visiting [redacted] now");
    expect(r.stderr).toBe("[redacted] in stderr");
  });

  it("redacts on the thrown (non-zero exit) path too", async () => {
    run.mockRejectedValue({ exitCode: 1, stdout: "", stderr: `failed at ${LINK}`, message: `exit 1: ${LINK}` });
    const r = await execCommand("sbx", "x", 1000, { env: { SMOKE_OWNER_LINK: LINK } });
    expect(r.exit_code).toBe(1);
    expect(JSON.stringify(r)).not.toContain("SECRET-MAGIC");
  });

  it("does not garble output with short non-secret values (e.g. a '1' flag)", async () => {
    run.mockResolvedValue({ exitCode: 0, stdout: "1 journey passed", stderr: "" });
    const r = await execCommand("sbx", "x", 1000, { env: { SMOKE_ALLOW_WRITES: "1" } });
    expect(r.stdout).toBe("1 journey passed");
  });

  it("rejects an invalid env key name before running anything", async () => {
    await expect(execCommand("sbx", "x", 1000, { env: { "BAD KEY;": "v" } })).rejects.toThrow(/invalid env key/);
    expect(run).not.toHaveBeenCalled();
  });

  it("without options the call shape is unchanged", async () => {
    run.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await execCommand("sbx", "echo hi");
    expect(run.mock.calls[0][1]).toEqual({ timeoutMs: 30_000 });
  });
});

describe("execCommand exit status", () => {
  const wrappedFor = async (command: string): Promise<string> => {
    run.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await execCommand("sbx", command);
    return run.mock.calls[0][0] as string;
  };
  const bash = (script: string): number => {
    try {
      execFileSync("/bin/bash", ["-c", script], { stdio: "ignore" });
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? -1;
    }
  };

  it("keeps the command's own exit code and set -e behaviour when the wrapped script really runs", async () => {
    const cases: Array<[string, number]> = [
      ["echo a; exit 0", 0],
      ["echo a; exit 3", 3],
      ["echo a", 0],
      ["false; echo not-reached", 1],
      ["if true; then exit 0; fi; exit 1", 0],
      ["cat <<'EOF'\nhello )\nEOF", 0],
    ];
    for (const [cmd, code] of cases) {
      run.mockReset();
      expect([cmd, bash(await wrappedFor(cmd))]).toEqual([cmd, code]);
    }
  });
});

describe("sandbox env-file allowlist", () => {
  it("allows the site's public Supabase URL and anon key", () => {
    expect(() =>
      assertAllowlistedEnvKeys({ VITE_SUPABASE_URL: "https://x.supabase.co", VITE_SUPABASE_ANON_KEY: "anon" }),
    ).not.toThrow();
  });
  it("still refuses a service-role key", () => {
    expect(() => assertAllowlistedEnvKeys({ VITE_SUPABASE_SERVICE_ROLE_KEY: "x" })).toThrow(/non-allowlisted/);
    expect(() => assertAllowlistedEnvKeys({ SUPABASE_SERVICE_ROLE_KEY: "x" })).toThrow(/non-allowlisted/);
  });
});
