import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBoolSetting: vi.fn(),
  execCommand: vi.fn(),
  getSandboxHost: vi.fn(),
  rpc: vi.fn(),
  sandboxRow: { id: "row-1" } as { id: string } | null,
}));

vi.mock("@/services/settings", () => ({ getBoolSetting: mocks.getBoolSetting }));
vi.mock("../e2b-client", () => ({
  execCommand: mocks.execCommand,
  getSandboxHost: mocks.getSandboxHost,
  resumeSandbox: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: mocks.sandboxRow, error: null }) }),
        }),
      }),
    }),
    rpc: mocks.rpc,
  }),
}));

import {
  bootEngineerPreviewForRun,
  engineerPreviewSourceDir,
  previewDirFor,
} from "../engineer-preview";

const RUN_ID = "11ba5244-f176-42f8-81cc-a5c35a93b2d7";
const CART_FILES = [
  { path: "components/CartDrawer.tsx", content: "export function CartDrawer() { return null; }" },
];

function bootForRefine(provisioned_refine: boolean, worktree_dir: string | undefined = undefined) {
  return bootEngineerPreviewForRun({
    sandbox_id: "sbx-1",
    tenant_id: "b92dcbf1-bac9-457a-af81-0bbe5984339b",
    repo_full_name: "Praxis-build/mohit-93bd8436",
    run_id: RUN_ID,
    worktree_dir: engineerPreviewSourceDir({ worktree_dir, provisioned_refine }),
    files: CART_FILES,
  });
}

beforeEach(() => {
  mocks.getBoolSetting.mockReset().mockResolvedValue(true);
  mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  mocks.getSandboxHost.mockReset().mockResolvedValue("https://3000-sbx-1.e2b.app");
  mocks.sandboxRow = { id: "row-1" };
  mocks.execCommand.mockReset().mockImplementation(async (_sbx: string, script: string) => {
    if (script.includes("__PREVCOPY__")) return { stdout: "__PREVCOPY__OK\n", stderr: "", exit_code: 0 };
    return { stdout: '__PREVIEW__{"ready":1,"port":3000}\n', stderr: "", exit_code: 0 };
  });
  delete process.env.INSTANT_PREVIEW_ENABLED;
});

describe("engineerPreviewSourceDir", () => {
  it("a run with its own worktree previews that worktree", () => {
    expect(engineerPreviewSourceDir({ worktree_dir: "/home/user/wt/run-1", provisioned_refine: true })).toBe(
      "/home/user/wt/run-1",
    );
    expect(engineerPreviewSourceDir({ worktree_dir: "/home/user/wt/run-1", provisioned_refine: false })).toBe(
      "/home/user/wt/run-1",
    );
  });

  it("a build refine has no worktree by design and previews the shared tree it edited", () => {
    expect(engineerPreviewSourceDir({ worktree_dir: undefined, provisioned_refine: true })).toBe("/home/user/repo");
    expect(engineerPreviewSourceDir({ worktree_dir: null, provisioned_refine: true })).toBe("/home/user/repo");
  });

  it("any other run without a worktree still gets no preview", () => {
    expect(engineerPreviewSourceDir({ worktree_dir: undefined, provisioned_refine: false })).toBeNull();
  });
});

describe("bootEngineerPreviewForRun for a build refine (provisioned repo, no worktree)", () => {
  it("boots a live preview copied from the shared tree the refine edited, so the change is visible before Render deploys", async () => {
    await expect(bootForRefine(true)).resolves.toEqual({ booted: true, reason: "live" });

    const copyScript = String(mocks.execCommand.mock.calls[0][1]);
    expect(copyScript).toContain("( cd '/home/user/repo' && tar cf - --exclude=node_modules --exclude=.git . )");
    expect(copyScript).toContain(`cd '${previewDirFor(RUN_ID)}' && tar xf -`);

    const bootScript = String(mocks.execCommand.mock.calls[1][1]);
    expect(bootScript).toContain(`ROOT='${previewDirFor(RUN_ID)}'`);
    expect(bootScript).not.toContain("ROOT='/home/user/repo'");

    const liveWrite = mocks.rpc.mock.calls.find(
      ([name, args]) => name === "set_engineer_sandbox_preview" && (args as { p_status: string }).p_status === "live",
    );
    expect(liveWrite?.[1]).toMatchObject({
      p_id: "row-1",
      p_run_id: RUN_ID,
      p_url: "https://3000-sbx-1.e2b.app",
      p_port: 3000,
    });
  });

  it("before this fix the same refine was skipped as no_worktree and nothing ran in the sandbox", async () => {
    await expect(bootForRefine(false)).resolves.toEqual({ booted: false, reason: "no_worktree" });
    expect(mocks.execCommand).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("flag off: a build refine still boots nothing", async () => {
    mocks.getBoolSetting.mockResolvedValue(false);
    await expect(bootForRefine(true)).resolves.toEqual({ booted: false, reason: "disabled" });
    expect(mocks.execCommand).not.toHaveBeenCalled();
  });

  it("a dev-server that never serves marks the preview dead, so the web falls back to the hosted app", async () => {
    mocks.execCommand.mockImplementation(async (_sbx: string, script: string) => {
      if (script.includes("__PREVCOPY__")) return { stdout: "__PREVCOPY__OK\n", stderr: "", exit_code: 0 };
      return { stdout: '__PREVIEW__{"ready":0,"port":0,"reason":"boot_timeout:port_unbound"}\n', stderr: "", exit_code: 1 };
    });
    await expect(bootForRefine(true)).resolves.toEqual({ booted: false, reason: "boot_failed" });
    expect(mocks.rpc).toHaveBeenCalledWith("expire_engineer_sandbox_preview", {
      p_id: "row-1",
      p_reason: "boot_timeout:port_unbound",
    });
  });
});
