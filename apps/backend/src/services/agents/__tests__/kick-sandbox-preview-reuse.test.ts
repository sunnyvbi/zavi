import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ error: null as null | { message: string } }));
let row: Record<string, unknown> | null = null;

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
    }),
    rpc,
  }),
}));

const execCommand = vi.fn();
const getSandboxHost = vi.fn(async (_id: string, port: number) => `https://${port}-sb-1.e2b.app`);
vi.mock("@/services/sandbox/e2b-client", async (orig) => ({
  ...(await orig<typeof import("@/services/sandbox/e2b-client")>()),
  execCommand: (...a: unknown[]) => execCommand(...a),
  getSandboxHost: (id: string, port: number) => getSandboxHost(id, port),
}));

const startPreviewServer = vi.fn(async () => ({ url: "https://3000-sb-1.e2b.app", port: 3000 }));
vi.mock("@/services/sandbox/preview", async (orig) => ({
  ...(await orig<typeof import("@/services/sandbox/preview")>()),
  startPreviewServer: (...a: unknown[]) => startPreviewServer(...(a as [])),
}));

import { __resetPreviewConfigRefreshes, kickPreviewReadiness, kickSandboxPreview } from "@/services/agents/conductor-driver";
import type { ConductorNode } from "@/services/agents/conductor";

const node = { payload: { stage: "scaffold", target: { github_full_name: "Praxis-build/app" } } } as unknown as ConductorNode;

const probeReady = vi.fn(async (_url: string) => true);
kickPreviewReadiness.probeReady = probeReady;
kickPreviewReadiness.sleep = async () => {};

beforeEach(() => {
  probeReady.mockReset();
  probeReady.mockImplementation(async () => true);
  __resetPreviewConfigRefreshes();
  rpc.mockReset();
  rpc.mockImplementation(async () => ({ error: null }));
  execCommand.mockReset();
  getSandboxHost.mockClear();
  startPreviewServer.mockClear();
});

describe("kickSandboxPreview after the stale preview was hidden", () => {
  it("re-publishes the dev server that still answers instead of booting a second one", async () => {
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "dead", preview_port: 3000 };
    execCommand.mockResolvedValue({ stdout: "200", stderr: "", exit_code: 0 });
    kickSandboxPreview({ tenant_id: "t1", node });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledWith("set_sandbox_preview", {
      p_id: "row-1",
      p_url: "https://3000-sb-1.e2b.app",
      p_port: 3000,
      p_status: "live",
    });
    expect(startPreviewServer).not.toHaveBeenCalled();
  });

  it("leaves an already live row untouched", async () => {
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 3000 };
    execCommand.mockResolvedValue({ stdout: "200", stderr: "", exit_code: 0 });
    kickSandboxPreview({ tenant_id: "t1", node });
    await vi.waitFor(() => expect(execCommand).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(rpc).not.toHaveBeenCalled();
    expect(startPreviewServer).not.toHaveBeenCalled();
  });

  it("a config-only check on a preview that does not answer boots nothing", async () => {
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "dead", preview_port: 5173 };
    execCommand.mockResolvedValue({ stdout: "000", stderr: "", exit_code: 7 });
    kickSandboxPreview({ tenant_id: "t1", node, site: true, onlyIfAnswering: true });
    await vi.waitFor(() => expect(execCommand).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(startPreviewServer).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("boots a fresh dev server when nothing answers", async () => {
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "dead", preview_port: 3000 };
    execCommand.mockResolvedValue({ stdout: "000", stderr: "", exit_code: 7 });
    kickSandboxPreview({ tenant_id: "t1", node });
    await vi.waitFor(() => expect(startPreviewServer).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_sandbox_preview", expect.objectContaining({ p_status: "live" })),
    );
    expect(rpc).toHaveBeenCalledWith("set_sandbox_preview", expect.objectContaining({ p_status: "starting" }));
  });
});

function coldSandbox() {
  execCommand.mockImplementation(async (_id: string, cmd: string) =>
    cmd.startsWith("curl ") ? { stdout: "000", stderr: "", exit_code: 7 } : { stdout: "", stderr: "", exit_code: 0 },
  );
}

describe("kickSandboxPreview for a site", () => {
  it("fails closed: a site whose preview config cannot be written is marked dead and never booted", async () => {
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "dead", preview_port: null };
    execCommand.mockResolvedValue({ stdout: "000", stderr: "", exit_code: 7 });
    await kickSandboxPreview({ tenant_id: "t1", node, site: true });
    expect(startPreviewServer).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("clear_sandbox_preview", { p_id: "row-1", p_final_status: "dead" });
  });

  it("never boots a site under a row it could not mark starting", async () => {
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    coldSandbox();
    rpc.mockImplementation(async (_fn: string, args: Record<string, unknown>) => ({ error: args.p_status === "starting" ? { message: "db down" } : null }));
    await kickSandboxPreview({ tenant_id: "t1", node, site: true });
    expect(startPreviewServer).not.toHaveBeenCalled();
    rpc.mockImplementation(async () => ({ error: null }));
  });

  it("writes the picker config and boots the site's Vite server on its own port and repo", async () => {
    const { SITE_DEV_START_CMD } = await import("@/services/sites/sandbox-ready");
    const { writeSitePreviewConfigCmd } = await import("@/services/sites/preview-picker");
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "dead", preview_port: null };
    coldSandbox();
    startPreviewServer.mockResolvedValueOnce({ url: "https://5173-sb-1.e2b.app", port: 5173 });
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(startPreviewServer).toHaveBeenCalled());
    const cmds = execCommand.mock.calls.map((c) => c[1]);
    expect(cmds).toContain(writeSitePreviewConfigCmd());
    expect(startPreviewServer).toHaveBeenCalledWith("sb-1", 5173, {
      repo_dir: "/home/user/repo",
      start_cmd: SITE_DEV_START_CMD,
      sanitize_secret_env: true,
    });
    await vi.waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_sandbox_preview", {
        p_id: "row-1",
        p_url: "https://5173-sb-1.e2b.app",
        p_port: 5173,
        p_status: "live",
      }),
    );
  });

  it("a site preview that still answers gets this checkout's runtime config refreshed, so Vite restarts on it when it changed", async () => {
    const { refreshSitePreviewConfigCmd, writeSitePreviewConfigCmd } = await import("@/services/sites/preview-picker");
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    execCommand.mockResolvedValue({ stdout: "200", stderr: "", exit_code: 0 });
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(execCommand.mock.calls.map((c) => c[1])).toContain(refreshSitePreviewConfigCmd()));
    const cmds = execCommand.mock.calls.map((c) => c[1]);
    expect(cmds).not.toContain(writeSitePreviewConfigCmd());
    expect(startPreviewServer).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("two kicks inside the cooldown refresh the config once, so a writer on older code cannot make it ping-pong", async () => {
    const { refreshSitePreviewConfigCmd } = await import("@/services/sites/preview-picker");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    execCommand.mockImplementation(async (_id: string, cmd: string) =>
      cmd === refreshSitePreviewConfigCmd()
        ? { stdout: "__config=rewritten\n", stderr: "", exit_code: 0 }
        : { stdout: "200", stderr: "", exit_code: 0 },
    );
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(execCommand.mock.calls.map((c) => c[1])).toContain(refreshSitePreviewConfigCmd()));
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(execCommand.mock.calls.length).toBeGreaterThanOrEqual(3));
    await new Promise((r) => setTimeout(r, 0));
    expect(execCommand.mock.calls.map((c) => c[1]).filter((c) => c === refreshSitePreviewConfigCmd())).toHaveLength(1);
    expect(info.mock.calls.map((c) => String(c[0]))).toContain("[preview-config] sandbox=sb-1 outcome=rewritten reason=version-or-sha-drift");
    info.mockRestore();
  });

  it("a rewritten config is followed by exactly one stop and one restart of the dev server, and none inside the cooldown", async () => {
    const { refreshSitePreviewConfigCmd } = await import("@/services/sites/preview-picker");
    const { STOP_TEMPLATE_DEV_SERVER_CMD } = await import("@/services/sites/sandbox-ready");
    vi.spyOn(console, "info").mockImplementation(() => {});
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    execCommand.mockImplementation(async (_id: string, cmd: string) =>
      cmd === refreshSitePreviewConfigCmd()
        ? { stdout: "__config=rewritten\n", stderr: "", exit_code: 0 }
        : { stdout: "200", stderr: "", exit_code: 0 },
    );
    startPreviewServer.mockResolvedValueOnce({ url: "https://5173-sb-1.e2b.app", port: 5173 });
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(startPreviewServer).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith("set_sandbox_preview", expect.objectContaining({ p_status: "live" })));
    const cmds = () => execCommand.mock.calls.map((c) => c[1] as string);
    expect(cmds().filter((c) => c === STOP_TEMPLATE_DEV_SERVER_CMD)).toHaveLength(1);
    expect(cmds().indexOf(STOP_TEMPLATE_DEV_SERVER_CMD)).toBeGreaterThan(cmds().indexOf(refreshSitePreviewConfigCmd()));
    const before = execCommand.mock.calls.length;
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(execCommand.mock.calls.length).toBeGreaterThan(before));
    await new Promise((r) => setTimeout(r, 10));
    expect(startPreviewServer).toHaveBeenCalledTimes(1);
    expect(cmds().filter((c) => c === STOP_TEMPLATE_DEV_SERVER_CMD)).toHaveLength(1);
    vi.mocked(console.info).mockRestore();
  });

  it("a dev server that will not stop is left running, with no second server booted", async () => {
    const { refreshSitePreviewConfigCmd } = await import("@/services/sites/preview-picker");
    const { STOP_TEMPLATE_DEV_SERVER_CMD } = await import("@/services/sites/sandbox-ready");
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    execCommand.mockImplementation(async (_id: string, cmd: string) =>
      cmd === refreshSitePreviewConfigCmd()
        ? { stdout: "__config=rewritten\n", stderr: "", exit_code: 0 }
        : cmd === STOP_TEMPLATE_DEV_SERVER_CMD
          ? { stdout: "", stderr: "", exit_code: 1 }
          : { stdout: "200", stderr: "", exit_code: 0 },
    );
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(startPreviewServer).not.toHaveBeenCalled();
    vi.mocked(console.info).mockRestore();
    warn.mockRestore();
  });

  it("an unchanged config does not start the cooldown, so the next real drift is still picked up", async () => {
    const { refreshSitePreviewConfigCmd } = await import("@/services/sites/preview-picker");
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    execCommand.mockImplementation(async (_id: string, cmd: string) =>
      cmd === refreshSitePreviewConfigCmd()
        ? { stdout: "__config=unchanged\n", stderr: "", exit_code: 0 }
        : { stdout: "200", stderr: "", exit_code: 0 },
    );
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(execCommand.mock.calls.map((c) => c[1])).toContain(refreshSitePreviewConfigCmd()));
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(execCommand.mock.calls.map((c) => c[1]).filter((c) => c === refreshSitePreviewConfigCmd())).toHaveLength(2));
  });

  it("a site wake or undo clears a first draft a settled build left (even on a running server); a build's own config check never does", async () => {
    const { CLEAR_FIRST_DRAFT_CMD } = await import("@/services/sites/first-draft");
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    execCommand.mockResolvedValue({ stdout: "200", stderr: "", exit_code: 0 });
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(execCommand.mock.calls.map((c) => c[1])).toContain(CLEAR_FIRST_DRAFT_CMD));
    execCommand.mockClear();
    kickSandboxPreview({ tenant_id: "t1", node, site: true, onlyIfAnswering: true });
    await vi.waitFor(() => expect(execCommand).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(execCommand.mock.calls.map((c) => c[1])).not.toContain(CLEAR_FIRST_DRAFT_CMD);
  });

  it("an app that is not a site keeps the old boot with no picker config", async () => {
    const { writeSitePreviewConfigCmd } = await import("@/services/sites/preview-picker");
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "dead", preview_port: null };
    execCommand.mockResolvedValue({ stdout: "000", stderr: "", exit_code: 7 });
    kickSandboxPreview({ tenant_id: "t1", node });
    await vi.waitFor(() => expect(startPreviewServer).toHaveBeenCalled());
    expect(execCommand.mock.calls.map((c) => c[1])).not.toContain(writeSitePreviewConfigCmd());
    expect(startPreviewServer).toHaveBeenCalledWith("sb-1", 3000, { sanitize_secret_env: true });
  });

  it("a site boot goes 'live' only once the public url serves the app (twice in a row), never on the local 2xx alone", async () => {
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "dead", preview_port: null };
    coldSandbox();
    startPreviewServer.mockResolvedValueOnce({ url: "https://5173-sb-1.e2b.app", port: 5173 });
    const answers = [false, true, true];
    probeReady.mockImplementation(async () => answers.shift() ?? true);
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith("set_sandbox_preview", expect.objectContaining({ p_status: "live" })));
    expect(probeReady).toHaveBeenCalledTimes(3);
    expect(probeReady).toHaveBeenCalledWith("https://5173-sb-1.e2b.app");
    const statuses = rpc.mock.calls.map((c) => c[1].p_status);
    expect(statuses.lastIndexOf("starting")).toBeLessThan(statuses.indexOf("live"));
  });

  it("a config restart marks the row 'starting' BEFORE it stops the running server", async () => {
    const { refreshSitePreviewConfigCmd } = await import("@/services/sites/preview-picker");
    const { STOP_TEMPLATE_DEV_SERVER_CMD } = await import("@/services/sites/sandbox-ready");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    const seq: string[] = [];
    rpc.mockImplementation(async (_fn: string, args: Record<string, unknown>) => {
      seq.push(`row:${String(args.p_status)}`);
      return { error: null };
    });
    execCommand.mockImplementation(async (_id: string, cmd: string) => {
      if (cmd === STOP_TEMPLATE_DEV_SERVER_CMD) seq.push("stop");
      return cmd === refreshSitePreviewConfigCmd() ? { stdout: "__config=rewritten\n", stderr: "", exit_code: 0 } : { stdout: "200", stderr: "", exit_code: 0 };
    });
    startPreviewServer.mockResolvedValueOnce({ url: "https://5173-sb-1.e2b.app", port: 5173 });
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(seq).toContain("row:live"));
    expect(seq.indexOf("row:starting")).toBeLessThan(seq.indexOf("stop"));
    info.mockRestore();
  });

  it("a 'starting' write that the database refuses means no stop and no restart (the next check retries)", async () => {
    const { refreshSitePreviewConfigCmd } = await import("@/services/sites/preview-picker");
    const { STOP_TEMPLATE_DEV_SERVER_CMD } = await import("@/services/sites/sandbox-ready");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    rpc.mockImplementation(async (_fn: string, args: Record<string, unknown>) =>
      args.p_status === "starting" ? { error: { message: "permission denied" } } : { error: null },
    );
    execCommand.mockImplementation(async (_id: string, cmd: string) =>
      cmd === refreshSitePreviewConfigCmd() ? { stdout: "__config=rewritten\n", stderr: "", exit_code: 0 } : { stdout: "200", stderr: "", exit_code: 0 },
    );
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(warn.mock.calls.some((c) => String(c[0]).includes("could not be marked starting"))).toBe(true));
    await new Promise((r) => setTimeout(r, 10));
    expect(execCommand.mock.calls.map((c) => c[1])).not.toContain(STOP_TEMPLATE_DEV_SERVER_CMD);
    expect(startPreviewServer).not.toHaveBeenCalled();
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(execCommand.mock.calls.map((c) => c[1]).filter((c) => c === refreshSitePreviewConfigCmd())).toHaveLength(2));
    info.mockRestore();
    warn.mockRestore();
  });

  it("a server that would not stop after the row was marked 'starting' is published 'live' again", async () => {
    const { refreshSitePreviewConfigCmd } = await import("@/services/sites/preview-picker");
    const { STOP_TEMPLATE_DEV_SERVER_CMD } = await import("@/services/sites/sandbox-ready");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    execCommand.mockImplementation(async (_id: string, cmd: string) =>
      cmd === refreshSitePreviewConfigCmd()
        ? { stdout: "__config=rewritten\n", stderr: "", exit_code: 0 }
        : cmd === STOP_TEMPLATE_DEV_SERVER_CMD
          ? { stdout: "", stderr: "", exit_code: 1 }
          : { stdout: "200", stderr: "", exit_code: 0 },
    );
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith("set_sandbox_preview", expect.objectContaining({ p_status: "live" })));
    expect(startPreviewServer).not.toHaveBeenCalled();
    info.mockRestore();
    warn.mockRestore();
  });
});
