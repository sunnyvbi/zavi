import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: vi.fn(async () => ({ stdout: "ok", stderr: "", exit_code: 0, ms: 1 })),
  readFile: vi.fn(async () => ""),
  readFileBytes: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => undefined),
}));

const L = vi.hoisted(() => ({ activeId: null as string | null }));
vi.mock("@/services/sandbox/lifecycle", () => ({
  getSandboxIdForRun: vi.fn(async () => L.activeId),
}));

import { mcpSandbox, clearSandboxReadCounter } from "@/services/agents/sdk/mcp-sandbox";
import { execCommand as execCommandRaw } from "@/services/sandbox/e2b-client";

const execMock = vi.mocked(execCommandRaw);

function getHandler(server: Awaited<ReturnType<typeof mcpSandbox>>, name: string) {
  const registered = (
    server as unknown as {
      instance: {
        _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }>;
      };
    }
  ).instance._registeredTools;
  const t = registered[name];
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

type ToolRes = { content: Array<{ text: string }>; isError?: boolean };

const TENANT = "t-1";
const REPO = "acme/app";

beforeEach(() => {
  execMock.mockClear();
  L.activeId = null;
  clearSandboxReadCounter("runLazy");
  clearSandboxReadCounter("runEager");
});

describe("mcpSandbox lazy provisioning (getSandboxId)", () => {
  it("LAZY: first code-tool call provisions on demand, then CACHES (no re-provision)", async () => {
    L.activeId = null;
    const lazyProvision = vi.fn(async () => "sbx-lazy");
    const server = await mcpSandbox({
      tenant_id: TENANT,
      run_id: "runLazy",
      repo_full_name: REPO,
      lazyProvision,
    });

    const r1 = (await getHandler(server, "run_bash")({ command: "ls" })) as ToolRes;
    expect(r1.isError).toBeUndefined();
    expect(lazyProvision).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls.at(-1)?.[0]).toBe("sbx-lazy");

    await getHandler(server, "run_bash")({ command: "pwd" });
    await getHandler(server, "git_status")({});
    expect(lazyProvision).toHaveBeenCalledTimes(1);
  });

  it("LAZY: a run that never calls a code tool never provisions (zero e2b cost)", async () => {
    const lazyProvision = vi.fn(async () => "sbx-lazy");
    await mcpSandbox({
      tenant_id: TENANT,
      run_id: "runLazy",
      repo_full_name: REPO,
      lazyProvision,
    });
    expect(lazyProvision).not.toHaveBeenCalled();
  });

  it("LAZY: transient provision failure → retryable tool-error (not a silent strand); next call retries", async () => {
    L.activeId = null;
    const lazyProvision = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("provisioning failed transiently — retry this tool call"), {
          name: "LazyProvisionError",
        }),
      )
      .mockResolvedValueOnce("sbx-lazy");
    const server = await mcpSandbox({
      tenant_id: TENANT,
      run_id: "runLazy",
      repo_full_name: REPO,
      lazyProvision,
    });

    const r1 = (await getHandler(server, "run_bash")({ command: "ls" })) as ToolRes;
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toContain("retry");
    expect(execMock).not.toHaveBeenCalled();

    const r2 = (await getHandler(server, "run_bash")({ command: "ls" })) as ToolRes;
    expect(r2.isError).toBeUndefined();
    expect(lazyProvision).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls.at(-1)?.[0]).toBe("sbx-lazy");
  });

  it("EAGER/engineer (no lazyProvision): an existing box is used verbatim — byte-identical", async () => {
    L.activeId = "sbx-eager";
    const server = await mcpSandbox({
      tenant_id: TENANT,
      run_id: "runEager",
      repo_full_name: REPO,
    });
    const r = (await getHandler(server, "run_bash")({ command: "ls" })) as ToolRes;
    expect(r.isError).toBeUndefined();
    expect(execMock.mock.calls.at(-1)?.[0]).toBe("sbx-eager");
  });

  it("EAGER/engineer (no lazyProvision) with NO box: fails loud with the original error → tool-error", async () => {
    L.activeId = null;
    const server = await mcpSandbox({
      tenant_id: TENANT,
      run_id: "runEager",
      repo_full_name: REPO,
    });
    const r = (await getHandler(server, "run_bash")({ command: "ls" })) as ToolRes;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("no active sandbox");
    expect(r.content[0].text).toContain("Did resolveSandboxForRun run?");
    expect(execMock).not.toHaveBeenCalled();
  });
});
