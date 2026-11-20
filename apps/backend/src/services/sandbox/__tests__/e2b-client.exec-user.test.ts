import { describe, expect, it, vi } from "vitest";

const runs: Array<{ cmd: string; opts: Record<string, unknown> }> = [];
vi.mock("e2b", () => ({
  Sandbox: {
    connect: async () => ({
      commands: {
        run: async (cmd: string, opts: Record<string, unknown>) => {
          runs.push({ cmd, opts });
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    }),
  },
}));

describe("execCommand as root", () => {
  it("never sources the user-writable env file, and runs as root with the given env", async () => {
    process.env.E2B_API_KEY = "test-key";
    const { execCommand } = await import("../e2b-client");
    await execCommand("sbx_1" as never, "git --version", 5_000, { user: "root", env: { GIT_CONFIG_NOSYSTEM: "1" } });
    await execCommand("sbx_1" as never, "git --version", 5_000);
    const [root, user] = runs;
    expect(root!.opts.user).toBe("root");
    expect(root!.cmd).not.toContain(".praxis-env");
    expect(root!.opts.envs).toEqual({ GIT_CONFIG_NOSYSTEM: "1" });
    expect(user!.opts.user).toBeUndefined();
    expect(user!.cmd).toContain(".praxis-env");
  });
});
