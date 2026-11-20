import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: vi.fn(async () => ({ stdout: "ok", stderr: "", exit_code: 0, ms: 1 })),
  readFile: vi.fn(async () => ""),
  readFileBytes: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => undefined),
}));

const L = vi.hoisted(() => ({ activeId: "sbx-from-db" as string | null }));
vi.mock("@/services/sandbox/lifecycle", () => ({
  getSandboxIdForRun: vi.fn(async () => L.activeId),
}));

import { mcpSandbox, clearSandboxReadCounter } from "@/services/agents/sdk/mcp-sandbox";
import { execCommand } from "@/services/sandbox/e2b-client";
import { getSandboxIdForRun } from "@/services/sandbox/lifecycle";

const execMock = vi.mocked(execCommand);
const lookup = vi.mocked(getSandboxIdForRun);

function handler(server: Awaited<ReturnType<typeof mcpSandbox>>, name: string) {
  return (server as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> } })
    .instance._registeredTools[name].handler;
}

beforeEach(() => {
  execMock.mockClear();
  lookup.mockClear();
  L.activeId = "sbx-from-db";
  clearSandboxReadCounter("runKnown");
});

describe("mcpSandbox with the sandbox id the worker already resolved", () => {
  it("the first tool call runs on the worker's box with no tenant_sandbox lookup, and so do later ones", async () => {
    const server = await mcpSandbox({ tenant_id: "t-1", run_id: "runKnown", repo_full_name: "acme/app", known_sandbox_id: "sbx-worker" });
    await handler(server, "run_bash")({ command: "ls" });
    await handler(server, "git_status")({});
    expect(lookup).not.toHaveBeenCalled();
    expect(execMock.mock.calls.map((c) => c[0])).toEqual(["sbx-worker", "sbx-worker"]);
  });

  it("without it, the run still looks its box up once (unchanged)", async () => {
    const server = await mcpSandbox({ tenant_id: "t-1", run_id: "runKnown", repo_full_name: "acme/app" });
    await handler(server, "run_bash")({ command: "ls" });
    await handler(server, "run_bash")({ command: "pwd" });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("t-1", "acme/app");
    expect(execMock.mock.calls.map((c) => c[0])).toEqual(["sbx-from-db", "sbx-from-db"]);
  });

  it("an empty id falls back to the lookup, and a missing eager box still fails loud", async () => {
    L.activeId = null;
    const server = await mcpSandbox({ tenant_id: "t-1", run_id: "runKnown", repo_full_name: "acme/app", known_sandbox_id: "" });
    const r = (await handler(server, "run_bash")({ command: "ls" })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/no active sandbox/);
    expect(execMock).not.toHaveBeenCalled();
  });
});
