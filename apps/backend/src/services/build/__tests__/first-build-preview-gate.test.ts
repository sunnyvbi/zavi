import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: vi.fn(async () => ({ stdout: "", stderr: "", exit_code: 0, ms: 1 })),
  readFile: vi.fn(async () => ""),
  readFileBytes: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => undefined),
}));
vi.mock("@/services/sandbox/lifecycle", () => ({
  getSandboxIdForRun: vi.fn(async () => "sb-1"),
}));

import { mcpSandbox, clearSandboxReadCounter } from "@/services/agents/sdk/mcp-sandbox";
import { writeFile as writeFileRaw } from "@/services/sandbox/e2b-client";
import {
  createFirstBuildPreviewWriteHook,
  firstBuildPreviewWriteHookFor,
  hideStaleFirstBuildPreview,
  isHomePagePath,
} from "@/services/build/first-build-preview";

const writeMock = vi.mocked(writeFileRaw);

function handler(server: Awaited<ReturnType<typeof mcpSandbox>>, name: string) {
  const t = (
    server as unknown as {
      instance: { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> };
    }
  ).instance._registeredTools[name];
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

function scriptedStatus(sequence: string[]) {
  const calls: string[] = [];
  const exec = vi.fn(async (_id: string, cmd: string) => {
    calls.push(cmd);
    return { stdout: sequence.shift() ?? "", stderr: "", exit_code: 0, ms: 1 };
  });
  return { exec, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  writeMock.mockReset();
  writeMock.mockResolvedValue(undefined);
  clearSandboxReadCounter("run-fb");
});

afterEach(() => {
  delete process.env.INSTANT_PREVIEW_ENABLED;
});

describe("first build preview waits for the agent to write the home page", () => {
  it("does not boot while the old app is untouched, boots exactly once when the home page changes", async () => {
    const kick = vi.fn();
    const { exec, calls } = scriptedStatus(["", " M app/page.tsx\n"]);
    const server = await mcpSandbox({
      tenant_id: "t1",
      run_id: "run-fb",
      repo_full_name: "Praxis-build/app",
      onWrite: createFirstBuildPreviewWriteHook(kick, exec as never),
    });

    await handler(server, "write_file")({ path: "app/components/Hero.tsx", content: "x" });
    await flush();
    expect(calls).toHaveLength(0);
    expect(kick).not.toHaveBeenCalled();

    await handler(server, "run_bash")({ command: "npm i zod", timeout_seconds: 60 });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("git status --porcelain -- app/page.tsx");
    expect(kick).not.toHaveBeenCalled();

    await handler(server, "write_file")({ path: "app/page.tsx", content: "house rentals" });
    await flush();
    expect(kick).toHaveBeenCalledTimes(1);

    await handler(server, "run_bash")({ command: "ls", timeout_seconds: 60 });
    await handler(server, "write_file")({ path: "app/page.tsx", content: "again" });
    await flush();
    expect(calls).toHaveLength(2);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("a home page write that failed leaves the preview hidden", async () => {
    const kick = vi.fn();
    const { exec, calls } = scriptedStatus([""]);
    writeMock.mockRejectedValueOnce(new Error("disk full"));
    const server = await mcpSandbox({
      tenant_id: "t1",
      run_id: "run-fb",
      repo_full_name: "r/a",
      onWrite: createFirstBuildPreviewWriteHook(kick, exec as never),
    });
    await handler(server, "write_file")({ path: "app/page.tsx", content: "x" }).catch(() => undefined);
    await flush();
    expect(calls).toHaveLength(1);
    expect(kick).not.toHaveBeenCalled();
  });

  it("a home page write through bash is caught by git status", async () => {
    const kick = vi.fn();
    const { exec } = scriptedStatus(["?? src/app/page.tsx\n"]);
    const hook = createFirstBuildPreviewWriteHook(kick, exec as never);
    await hook({ tool: "run_bash", sandbox_id: "sb-1" });
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("a str_replace that did not change the page (status clean) does not boot", async () => {
    const kick = vi.fn();
    const { exec } = scriptedStatus([""]);
    const hook = createFirstBuildPreviewWriteHook(kick, exec as never);
    await hook({ tool: "str_replace", path: "/home/user/repo/app/page.tsx", sandbox_id: "sb-1" });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(kick).not.toHaveBeenCalled();
  });

  it("parallel tool calls racing the status check boot the preview once", async () => {
    const kick = vi.fn();
    const exec = vi.fn(async () => {
      await flush();
      return { stdout: " M app/page.tsx", stderr: "", exit_code: 0, ms: 1 };
    });
    const hook = createFirstBuildPreviewWriteHook(kick, exec as never);
    await Promise.all([
      hook({ tool: "run_bash", sandbox_id: "sb-1" }),
      hook({ tool: "write_file", path: "app/page.tsx", sandbox_id: "sb-1" }),
      hook({ tool: "run_bash", sandbox_id: "sb-1" }),
    ]);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("a sandbox exec failure never throws into the agent and never boots", async () => {
    const kick = vi.fn();
    const hook = createFirstBuildPreviewWriteHook(kick, vi.fn().mockRejectedValue(new Error("gone")) as never);
    await expect(hook({ tool: "run_bash", sandbox_id: "sb-1" })).resolves.toBeUndefined();
    expect(kick).not.toHaveBeenCalled();
  });

  it("matches only the root home page", () => {
    expect(isHomePagePath("app/page.tsx")).toBe(true);
    expect(isHomePagePath("./src/app/page.tsx")).toBe(true);
    expect(isHomePagePath("/home/user/repo/app/page.tsx")).toBe(true);
    expect(isHomePagePath("app/laptops/page.tsx")).toBe(false);
    expect(isHomePagePath("app/page.test.tsx")).toBe(false);
    expect(isHomePagePath(undefined)).toBe(false);
  });
});

describe("firstBuildPreviewWriteHookFor", () => {
  const scaffold = { stage: "scaffold", target: { github_full_name: "Praxis-build/app" } };

  it("arms only for the scaffold of a fresh build on a Zavi-owned repo with previews on", () => {
    expect(firstBuildPreviewWriteHookFor(scaffold, vi.fn())).toBeTypeOf("function");
    expect(firstBuildPreviewWriteHookFor({ ...scaffold, stage: "build" }, vi.fn())).toBeUndefined();
    expect(firstBuildPreviewWriteHookFor({ ...scaffold, refine_mode: true }, vi.fn())).toBeUndefined();
    expect(firstBuildPreviewWriteHookFor({ ...scaffold, repair_mode: true }, vi.fn())).toBeUndefined();
    expect(
      firstBuildPreviewWriteHookFor({ stage: "scaffold", target: { github_target_mode: "user_repo", github_full_name: "me/x" } }, vi.fn()),
    ).toBeUndefined();
    expect(firstBuildPreviewWriteHookFor({ stage: "scaffold" }, vi.fn())).toBeUndefined();
    process.env.INSTANT_PREVIEW_ENABLED = "0";
    expect(firstBuildPreviewWriteHookFor(scaffold, vi.fn())).toBeUndefined();
  });
});

describe("hideStaleFirstBuildPreview", () => {
  const noopExec = vi.fn(async () => ({ stdout: "__FBP__STOPPED\n", stderr: "", exit_code: 0, ms: 1 }));
  function client(row: unknown, rpcError: unknown = null) {
    const rpc = vi.fn(async () => ({ error: rpcError }));
    const eqs: Array<[string, string]> = [];
    const c = {
      from: vi.fn(() => ({
        select: () => ({
          eq: (a: string, b: string) => {
            eqs.push([a, b]);
            return {
              eq: (x: string, y: string) => {
                eqs.push([x, y]);
                return { maybeSingle: async () => ({ data: row, error: null }) };
              },
            };
          },
        }),
      })),
      rpc,
    };
    return { c, rpc, eqs };
  }

  it("takes the previous app off the screen when the old dev server row is live", async () => {
    const { c, rpc, eqs } = client({ id: "row-1", preview_status: "live" });
    expect(await hideStaleFirstBuildPreview("t1", "Praxis-build/mohit-93bd8436", c, "sb-1", noopExec)).toBe("hidden");
    expect(eqs).toEqual([
      ["tenant_id", "t1"],
      ["repo_full_name", "Praxis-build/mohit-93bd8436"],
    ]);
    expect(rpc).toHaveBeenCalledWith("clear_sandbox_preview", { p_id: "row-1", p_final_status: "dead" });
  });

  it("leaves rows that frame nothing alone", async () => {
    for (const row of [null, { id: "row-1", preview_status: "dead" }, { id: "row-1", preview_status: "paused" }]) {
      const { c, rpc } = client(row);
      expect(await hideStaleFirstBuildPreview("t1", "r/a", c, "sb-1", noopExec)).toBe("none");
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("reports none when the clear fails", async () => {
    const { c } = client({ id: "row-1", preview_status: "starting" }, { message: "boom" });
    expect(await hideStaleFirstBuildPreview("t1", "r/a", c, "sb-1", noopExec)).toBe("none");
  });
});
