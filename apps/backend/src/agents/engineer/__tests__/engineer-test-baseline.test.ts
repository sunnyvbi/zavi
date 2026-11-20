
import { describe, it, expect, vi, beforeEach } from "vitest";

const exec = vi.hoisted(() => vi.fn());
vi.mock("@/services/sandbox/e2b-client", () => ({ execCommand: exec }));

import { attributeTestFailures, attributionSentence } from "../engineer-test-baseline";

const ok = (stdout = "", exit_code = 0) => ({ exit_code, stdout, stderr: "", ms: 1 });

const TREE = "a".repeat(40);
const HEAD = "b".repeat(40);
const SNAP = ok(`__ATTR_SNAP__ /tmp/zavi-attr-AbC123 ${TREE} ${HEAD}`);
const CHECK_OK = ok(`__ATTR_CHECK__ ${TREE} ${HEAD}`);
const CHECK_BAD = ok(`__ATTR_CHECK__ ${"c".repeat(40)} ${HEAD}`);

const base = {
  sandbox_id: "sbx-1" as never,
  worktree_path: "/repo/wt",
  command: "npm test",
  head_failures: ["a::1", "a::2", "b::new"],
  head_confidence: "high" as const,
};

function script(baseRun: ReturnType<typeof ok>, restore = CHECK_OK) {
  exec.mockReset();
  exec
    .mockResolvedValueOnce(SNAP)
    .mockResolvedValueOnce(ok())
    .mockResolvedValueOnce(baseRun)
    .mockResolvedValueOnce(restore)
    .mockResolvedValue(restore);
}

const cmds = () => exec.mock.calls.map((c) => String(c[1]));

beforeEach(() => exec.mockReset());

describe("attributeTestFailures — the happy path", () => {
  it("separates what the agent broke from what was already broken", async () => {
    script(ok("FAILED a::1 - x\nFAILED a::2 - y", 1));
    const r = await attributeTestFailures(base);
    expect(r).toEqual({
      kind: "attributed",
      new_failures: ["b::new"],
      pre_existing: ["a::1", "a::2"],
    });
  });

  it("base suite GREEN → every head failure is the agent's (no parse needed)", async () => {
    script(ok("all good", 0));
    const r = await attributeTestFailures(base);
    expect(r).toEqual({
      kind: "attributed",
      new_failures: ["a::1", "a::2", "b::new"],
      pre_existing: [],
    });
  });

  it("all head failures pre-existing → nothing new, PR must not be blocked", async () => {
    script(ok("FAILED a::1 - x\nFAILED a::2 - y\nFAILED b::new - z", 1));
    const r = await attributeTestFailures(base);
    expect(r).toEqual({
      kind: "attributed",
      new_failures: [],
      pre_existing: base.head_failures,
    });
  });
});

describe("attributeTestFailures — isolation (concurrent runs must not collide)", () => {
  it("snapshots through a temporary index, never the shared stash stack", async () => {
    script(ok("FAILED a::1 - x", 1));
    await attributeTestFailures(base);
    const c = cmds();
    expect(c[0]).toContain('GIT_INDEX_FILE="$D/snap-index" git add -A');
    expect(c[0]).toContain("git write-tree");
    expect(c.some((x) => /git stash/.test(x))).toBe(false);
    expect(c.some((x) => /export GIT_INDEX_FILE/.test(x))).toBe(false);
  });

  it("cleans untracked files but PRESERVES ignored ones (node_modules must survive)", async () => {
    script(ok("FAILED a::1 - x", 1));
    await attributeTestFailures(base);
    expect(cmds()[1]).toContain("clean -fdq");
    expect(cmds().some((x) => /clean -fdx|clean -xfd|clean -fxd/.test(x))).toBe(false);
  });
});

describe("attributeTestFailures — REFUSES rather than guess (never a false 'nothing new')", () => {
  it("no test command captured → unknown, and we never touch the sandbox", async () => {
    const r = await attributeTestFailures({ ...base, command: undefined });
    expect(r.kind).toBe("unknown");
    expect(exec).not.toHaveBeenCalled();
  });

  it("head failures unparseable → unknown, and we never touch the sandbox", async () => {
    const r = await attributeTestFailures({ ...base, head_confidence: "none" });
    expect(r.kind).toBe("unknown");
    expect(exec).not.toHaveBeenCalled();
  });

  it("snapshot fails → unknown, and we never reset a tree we cannot restore", async () => {
    exec.mockResolvedValueOnce(ok("fatal: something", 1));
    const r = await attributeTestFailures(base);
    expect(r.kind).toBe("unknown");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("snapshot output without valid ids → unknown, no reset", async () => {
    exec.mockResolvedValueOnce(ok("__ATTR_SNAP__ /tmp/zavi-attr-x nothex nothex", 0));
    const r = await attributeTestFailures(base);
    expect(r.kind).toBe("unknown");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("base is RED but unparseable → unknown, NOT 'base was green'", async () => {
    script(ok("make: *** [test] Error 1", 1));
    const r = await attributeTestFailures(base);
    expect(r.kind).toBe("unknown");
    if (r.kind === "unknown") expect(r.why).toMatch(/could not enumerate/i);
  });
});

describe("attributeTestFailures — always restores, and says when it could not", () => {
  it("restores even when the base test run throws, then rethrows", async () => {
    exec
      .mockResolvedValueOnce(SNAP)
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error("sandbox died"))
      .mockResolvedValue(CHECK_OK);
    await expect(attributeTestFailures(base)).rejects.toThrow("sandbox died");
    expect(cmds()[3]).toContain(`git read-tree --reset -u '${TREE}'`);
  });

  it("restores on the happy path and checks the result", async () => {
    script(ok("FAILED a::1 - x", 1));
    await attributeTestFailures(base);
    const restore = cmds()[3];
    expect(restore).toContain(`test "$(git rev-parse HEAD)" = '${HEAD}'`);
    expect(restore).toContain(`git read-tree --reset -u '${TREE}'`);
    expect(restore).toContain("real-index");
    expect(restore).toContain("__ATTR_CHECK__");
    expect(cmds()[4]).toContain("rm -rf '/tmp/zavi-attr-AbC123'");
  });

  it("a restore that does not verify keeps the split and adds restore_failed (never unknown)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    script(ok("FAILED a::1 - x\nFAILED a::2 - y", 1), CHECK_BAD);
    const r = await attributeTestFailures(base);
    expect(r).toEqual({
      kind: "attributed",
      new_failures: ["b::new"],
      pre_existing: ["a::1", "a::2"],
      restore_failed: true,
    });
    expect(cmds().filter((x) => x.includes("__ATTR_CHECK__"))).toHaveLength(2);
    expect(cmds().some((x) => x.startsWith("rm -rf"))).toBe(false);
  });

  it("a failed reset restores immediately and refuses to attribute", async () => {
    exec
      .mockResolvedValueOnce(SNAP)
      .mockResolvedValueOnce(ok("conflict", 1))
      .mockResolvedValue(CHECK_OK);
    const r = await attributeTestFailures(base);
    expect(r.kind).toBe("unknown");
    expect(r.restore_failed).toBeUndefined();
    expect(cmds()[2]).toContain("git read-tree --reset -u");
  });
});

describe("attributionSentence — what the operator actually reads", () => {
  it("blames the agent when the agent is to blame", () => {
    const s = attributionSentence(
      { kind: "attributed", new_failures: ["auth::expired"], pre_existing: ["old::1", "old::2"] },
      "development",
    );
    expect(s).toContain("I broke a test");
    expect(s).toContain("auth::expired");
    expect(s).toContain("2 others were already failing on `development`");
  });

  it("exonerates the change when nothing new broke — this is the Apna case", () => {
    const s = attributionSentence(
      { kind: "attributed", new_failures: [], pre_existing: ["a::1", "a::2", "a::3"] },
      "development",
    );
    expect(s).toContain("already failing on `development` before I started");
    expect(s).toContain("didn't break them");
    expect(s).not.toMatch(/I broke/);
  });

  it("says plainly when it does not know", () => {
    const s = attributionSentence({ kind: "unknown", why: "no test command" }, "main");
    expect(s).toContain("couldn't work out");
    expect(s).toContain("check before merging");
  });
});
