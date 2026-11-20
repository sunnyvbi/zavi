import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  getBoolSetting: vi.fn<[key: string, tenant_id?: string | null], Promise<boolean>>(),
}));
const edits = vi.hoisted(() => ({
  clearWebsiteEditsForTenant: vi.fn<[tenant_id: string], Promise<{ deleted?: number; error?: string }>>(),
}));

vi.mock("@/services/settings", () => ({ getBoolSetting: settings.getBoolSetting }));
vi.mock("@/routes/workspace/website-edits", () => ({
  clearWebsiteEditsForTenant: edits.clearWebsiteEditsForTenant,
}));

import {
  invalidateLiveEditState,
  publishDraft,
  realLiveEditDeps,
  type LiveEditDeps,
} from "@/services/build/live-edit";

const T = "tenant-1";
const TARGET = { github_full_name: "praxis-built/acme-1234", default_branch: "main" };
const HEAD = "b".repeat(40);

let order: string[];
let flags: Record<string, boolean | Error>;

function deps(over: Partial<LiveEditDeps> = {}): LiveEditDeps {
  return {
    enabled: vi.fn().mockResolvedValue(true),
    loadTarget: vi.fn().mockResolvedValue(TARGET),
    assertProvisioned: vi.fn().mockResolvedValue(true),
    installation: vi.fn().mockResolvedValue(-1),
    compare: vi.fn().mockResolvedValue({ ahead_by: 1, behind_by: 0, commits: [{ sha: HEAD, message: "refine" }] }),
    branchSha: vi.fn().mockResolvedValue(HEAD),
    changedFiles: vi.fn().mockResolvedValue(["app/page.tsx"]),
    protectedGlobs: vi.fn().mockResolvedValue(["**/.env*"]),
    fastForward: vi.fn(async () => {
      order.push("fastForward");
    }),
    deleteBranch: vi.fn().mockResolvedValue(true),
    hasActiveBuild: vi.fn().mockResolvedValue(false),
    loadPreviewRow: vi.fn().mockResolvedValue(null),
    clearPreview: vi.fn().mockResolvedValue(undefined),
    touchPreview: vi.fn().mockResolvedValue(undefined),
    requestStaticPublish: vi.fn(async () => {
      order.push("staticPublish");
    }),
    clearInlineEditsOnPublish: realLiveEditDeps.clearInlineEditsOnPublish,
    now: () => 1_000_000,
    ...over,
  };
}

beforeEach(() => {
  invalidateLiveEditState(T);
  order = [];
  flags = { live_edit_publish_clears_inline_edits: true };
  settings.getBoolSetting.mockReset().mockImplementation(async (key: string) => {
    const v = flags[key];
    if (v instanceof Error) throw v;
    return v === true;
  });
  edits.clearWebsiteEditsForTenant.mockReset().mockImplementation(async () => {
    order.push("clearInlineEdits");
    return { deleted: 3 };
  });
});

describe("publishDraft clears stale inline edits when the flag is on", () => {
  it("clears the tenant's inline edits only after main was fast-forwarded to the refined draft", async () => {
    const out = await publishDraft(T, deps());
    expect(out).toEqual({ commit_sha: HEAD, published: 1 });
    expect(edits.clearWebsiteEditsForTenant).toHaveBeenCalledTimes(1);
    expect(edits.clearWebsiteEditsForTenant).toHaveBeenCalledWith(T);
    expect(order.indexOf("fastForward")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("clearInlineEdits")).toBeGreaterThan(order.indexOf("fastForward"));
    expect(settings.getBoolSetting).toHaveBeenCalledWith("live_edit_publish_clears_inline_edits", T);
  });

  it("keeps inline edits when the fast-forward fails, so a failed publish never wipes the live site's overrides", async () => {
    const d = deps({ fastForward: vi.fn().mockRejectedValue(new Error("github 422")) });
    await expect(publishDraft(T, d)).rejects.toThrow("github 422");
    expect(edits.clearWebsiteEditsForTenant).not.toHaveBeenCalled();
  });

  it("keeps inline edits when publish is refused for protected paths", async () => {
    const d = deps({ changedFiles: vi.fn().mockResolvedValue([".env.production"]) });
    await expect(publishDraft(T, d)).rejects.toMatchObject({ code: "protected_paths" });
    expect(d.fastForward).not.toHaveBeenCalled();
    expect(edits.clearWebsiteEditsForTenant).not.toHaveBeenCalled();
  });

  it("keeps inline edits while a build is running", async () => {
    const d = deps({ hasActiveBuild: vi.fn().mockResolvedValue(true) });
    await expect(publishDraft(T, d)).rejects.toMatchObject({ code: "build_in_progress" });
    expect(edits.clearWebsiteEditsForTenant).not.toHaveBeenCalled();
  });

  it("still reports the publish as done when the clear fails, and still requests the static publish", async () => {
    edits.clearWebsiteEditsForTenant.mockResolvedValue({ error: "permission denied" });
    const d = deps();
    const out = await publishDraft(T, d);
    expect(out).toEqual({ commit_sha: HEAD, published: 1 });
    expect(d.fastForward).toHaveBeenCalledTimes(1);
    expect(d.requestStaticPublish).toHaveBeenCalledTimes(1);
  });
});

describe("publishDraft leaves inline edits alone when the flag is off", () => {
  it("does not clear with the flag off", async () => {
    flags.live_edit_publish_clears_inline_edits = false;
    await publishDraft(T, deps());
    expect(edits.clearWebsiteEditsForTenant).not.toHaveBeenCalled();
  });

  it("does not clear when the flag cannot be read", async () => {
    flags.live_edit_publish_clears_inline_edits = new Error("settings down");
    const out = await publishDraft(T, deps());
    expect(out.commit_sha).toBe(HEAD);
    expect(edits.clearWebsiteEditsForTenant).not.toHaveBeenCalled();
  });
});
