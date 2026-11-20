import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SiteRow } from "@/services/sites/contract";
import { WORKING_TREE_HASH_CMD, previewTreeState, wakeSitePreview, type SitePreviewWakeDeps } from "@/services/sites/site-preview-wake";

const REPO = "Zavi-Latest-Build/some-site";
let dir: string;

function git(...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(path: string, content: string) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
}

const treeOf = (sha: string) => git("rev-parse", `${sha}^{tree}`);

function siteRepo(): { seed: string; build: string; edit: string } {
  git("init", "-q", "-b", "main");
  write(".gitignore", "node_modules\n");
  write("src/pages/Home.tsx", "export default () => <Hero />;\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  const seed = git("rev-parse", "HEAD");
  write("src/pages/Home.tsx", "export default () => <><Hero /><Features /></>;\n");
  write("src/lib/booking.ts", "export const slots = 3;\n");
  git("add", "-A");
  git("commit", "-qm", "first build");
  const build = git("rev-parse", "HEAD");
  write("src/pages/Home.tsx", "export default () => <><Hero /><Features /><FAQ /></>;\n");
  git("add", "-A");
  git("commit", "-qm", "chat edit");
  const edit = git("rev-parse", "HEAD");
  git("reset", "-q", "--hard", seed);
  write("src/pages/Home.tsx", "export default () => <><Hero /><Features /></>;\n");
  write("src/lib/booking.ts", "export const slots = 3;\n");
  mkdirSync(join(dir, "node_modules", "react"), { recursive: true });
  write("node_modules/react/index.js", "module.exports = 1;\n");
  write(".env.local", "VITE_SUPABASE_URL=x\n");
  write(".git/info/exclude", ".env.local\n");
  return { seed, build, edit };
}

const exec: SitePreviewWakeDeps["exec"] = async (_id, cmd) => {
  const local = cmd.split("/home/user/repo").join(dir);
  const r = spawnSync("bash", ["-c", `(set -e; ${local}\n)`], { encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, exit_code: r.status ?? 1 };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zwake-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the box's working tree is compared with main's head by content", () => {
  it("a box holding the last build's files uncommitted matches that commit, and the repo is left as it was", async () => {
    const { build } = siteRepo();
    const before = git("status", "--porcelain");
    const r = await previewTreeState({ sandbox_id: "sb", repo_full_name: REPO }, { headTree: async () => ({ sha: build, tree: treeOf(build) }), exec });
    expect(r).toEqual({ state: "same", sha: build });
    expect(git("status", "--porcelain")).toBe(before);
    expect(git("rev-parse", "HEAD")).not.toBe(build);
  });

  it("a box resumed from a snapshot older than the latest edit is stale", async () => {
    const { edit } = siteRepo();
    const r = await previewTreeState({ sandbox_id: "sb", repo_full_name: REPO }, { headTree: async () => ({ sha: edit, tree: treeOf(edit) }), exec });
    expect(r.state).toBe("stale");
  });

  it("ignored deps and env never count, an extra source file does", async () => {
    const { build } = siteRepo();
    write("node_modules/react/extra.js", "x\n");
    write(".env.local", "VITE_SUPABASE_URL=changed\n");
    const head = async () => ({ sha: build, tree: treeOf(build) });
    expect((await previewTreeState({ sandbox_id: "sb", repo_full_name: REPO }, { headTree: head, exec })).state).toBe("same");
    write("src/pages/Draft.tsx", "export default () => null;\n");
    expect((await previewTreeState({ sandbox_id: "sb", repo_full_name: REPO }, { headTree: head, exec })).state).toBe("stale");
  });

  it("a deleted file counts", async () => {
    const { build } = siteRepo();
    rmSync(join(dir, "src/lib/booking.ts"));
    const r = await previewTreeState({ sandbox_id: "sb", repo_full_name: REPO }, { headTree: async () => ({ sha: build, tree: treeOf(build) }), exec });
    expect(r.state).toBe("stale");
  });

  it("an unreadable head or a box that will not answer is unknown, never stale", async () => {
    siteRepo();
    expect(
      (await previewTreeState({ sandbox_id: "sb", repo_full_name: REPO }, { headTree: async () => ({ error: "GitHub answered 502" }), exec })).state,
    ).toBe("unknown");
    expect(
      (
        await previewTreeState(
          { sandbox_id: "sb", repo_full_name: REPO },
          { headTree: async () => ({ sha: "a".repeat(40), tree: "b".repeat(40) }), exec: async () => ({ stdout: "", stderr: "", exit_code: 1 }) },
        )
      ).state,
    ).toBe("unknown");
  });

  it("the command carries no credential and writes nothing the repo tracks", () => {
    expect(WORKING_TREE_HASH_CMD).not.toMatch(/token|x-access|fetch|checkout|reset|clean/i);
  });
});

describe("wakeSitePreview", () => {
  const site = { id: "site-1", tenant_id: "t1", github_full_name: REPO } as unknown as SiteRow;

  function deps(state: "same" | "stale" | "unknown" | "no-box") {
    const kick = vi.fn(async () => undefined);
    const order: string[] = [];
    const restart = vi.fn(async () => void order.push("restart"));
    const previewChanged = vi.fn(async (_t: string, _s: string) => void order.push("changed"));
    const d: Partial<SitePreviewWakeDeps> = {
      previewChanged,
      sandboxIdOf: async () => (state === "no-box" ? null : "sb-1"),
      headTree: async () => (state === "unknown" ? { error: "down" } : { sha: "c".repeat(40), tree: "d".repeat(40) }),
      exec: async () => ({ stdout: `__tree=${state === "stale" ? "e".repeat(40) : "d".repeat(40)}\n`, stderr: "", exit_code: 0 }),
      kick,
      restart,
      log: () => undefined,
    };
    return { d, kick, restart, previewChanged, order };
  }

  it("a stale box is set up again on a fresh box at the head, never woken as it is", async () => {
    const { d, kick, restart } = deps("stale");
    expect(await wakeSitePreview({ tenant_id: "t1", run_id: "run-1", site }, d)).toBe("recreated");
    expect(restart).toHaveBeenCalledWith({ tenant_id: "t1", run_id: "run-1", site, sha: "c".repeat(40), awaitReadiness: true });
    expect(kick).not.toHaveBeenCalled();
  });

  it("a stale box set up at a newer head marks the preview changed before and after, so no saved snapshot of the old tree is shown", async () => {
    const { d, previewChanged, order } = deps("stale");
    await wakeSitePreview({ tenant_id: "t1", run_id: "run-1", site }, d);
    expect(order).toEqual(["changed", "restart", "changed"]);
    expect(previewChanged).toHaveBeenCalledWith("t1", "site-1");
  });

  it("a box already on the head changes nothing, so its snapshot stays usable", async () => {
    const { d, previewChanged } = deps("same");
    await wakeSitePreview({ tenant_id: "t1", run_id: "run-1", site }, d);
    expect(previewChanged).not.toHaveBeenCalled();
  });

  for (const state of ["same", "unknown", "no-box"] as const) {
    it(`a box that is ${state === "same" ? "on the head" : state === "unknown" ? "not comparable" : "missing"} gets the normal wake`, async () => {
      const { d, kick, restart } = deps(state);
      expect(await wakeSitePreview({ tenant_id: "t1", run_id: "run-1", site }, d)).toBe("woken");
      expect(kick).toHaveBeenCalledWith("t1", REPO);
      expect(restart).not.toHaveBeenCalled();
    });
  }

  it("refuses a site of another workspace", async () => {
    const { d } = deps("same");
    await expect(wakeSitePreview({ tenant_id: "t2", run_id: "run-1", site }, d)).rejects.toThrow(/workspace/);
  });
});
