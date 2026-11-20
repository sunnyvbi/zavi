
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/services/sandbox/e2b-client", () => ({ execCommand: vi.fn() }));
import {
  resolveCheckoutBase,
  isSafeBranch,
  createRunWorktree,
} from "../run-worktree";
import { execCommand } from "@/services/sandbox/e2b-client";

const exec = vi.mocked(execCommand);
beforeEach(() => {
  exec.mockReset();
});
const res = (stdout: string, exit_code = 0) => ({
  stdout,
  stderr: "",
  exit_code,
  ms: 0,
});

const BACKEND_ROOT = join(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(BACKEND_ROOT, rel), "utf8");

describe("isSafeBranch allows engineer/* branches", () => {
  it("accepts engineer/* PR head branches", () => {
    expect(isSafeBranch("engineer/x")).toBe(true);
    expect(isSafeBranch("engineer/DEL-318-followup-abc")).toBe(true);
    expect(isSafeBranch("main")).toBe(true);
  });
  it("rejects flag-injection / empty / shell-meta values", () => {
    expect(isSafeBranch("--evil; rm -rf /")).toBe(false);
    expect(isSafeBranch("")).toBe(false);
    expect(isSafeBranch("a branch")).toBe(false);
    expect(isSafeBranch("$(whoami)")).toBe(false);
  });
});

describe("resolveCheckoutBase (DEL-318 S2 base precedence)", () => {
  const DEFAULT = "main";

  it("engineer_pr_followup with checkout_ref → that branch, NOT the default", () => {
    const base = resolveCheckoutBase({
      payload: {
        kind: "engineer_pr_followup",
        checkout_ref: "engineer/x",
        target_pr_number: 42,
      },
      defaultBase: DEFAULT,
    });
    expect(base).toBe("engineer/x");
    expect(base).not.toBe(DEFAULT);
  });

  it("engineer_pr_shepherd with head_branch (legacy key) → that branch, NOT the default", () => {
    const base = resolveCheckoutBase({
      payload: { kind: "engineer_pr_shepherd", head_branch: "engineer/x" },
      defaultBase: DEFAULT,
    });
    expect(base).toBe("engineer/x");
    expect(base).not.toBe(DEFAULT);
  });

  it("checkout_ref WINS over head_branch when both present", () => {
    const base = resolveCheckoutBase({
      payload: {
        checkout_ref: "engineer/from-followup",
        head_branch: "engineer/from-shepherd",
      },
      defaultBase: DEFAULT,
    });
    expect(base).toBe("engineer/from-followup");
  });

  it("NO override key → bases on the default branch exactly as before (hot path guard)", () => {
    expect(resolveCheckoutBase({ payload: {}, defaultBase: DEFAULT })).toBe(DEFAULT);
    expect(resolveCheckoutBase({ payload: null, defaultBase: DEFAULT })).toBe(DEFAULT);
    expect(resolveCheckoutBase({ payload: undefined, defaultBase: DEFAULT })).toBe(DEFAULT);
    expect(
      resolveCheckoutBase({
        payload: { kind: "engineer", repo_hint: "owner/repo" },
        defaultBase: DEFAULT,
      }),
    ).toBe(DEFAULT);
  });

  it("unsafe override value falls back to default (never fails the run)", () => {
    expect(
      resolveCheckoutBase({
        payload: { checkout_ref: "--evil; rm -rf /" },
        defaultBase: DEFAULT,
      }),
    ).toBe(DEFAULT);
    expect(
      resolveCheckoutBase({
        payload: { checkout_ref: 123 as unknown as string },
        defaultBase: DEFAULT,
      }),
    ).toBe(DEFAULT);
  });

  it("a non-default custom default base is preserved when no override", () => {
    expect(resolveCheckoutBase({ payload: {}, defaultBase: "develop" })).toBe("develop");
  });
});

describe("createRunWorktree cuts from the resolved checkout_ref base", () => {
  it("checkout_ref:'engineer/x' drives `git worktree add ... origin/engineer/x`", async () => {
    exec.mockResolvedValue(res("Preparing worktree\nRC=0"));
    const base = resolveCheckoutBase({
      payload: { kind: "engineer_pr_followup", checkout_ref: "engineer/x" },
      defaultBase: "main",
    });
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "abc-123", base });
    expect(r.ok).toBe(true);
    const cmd = String(exec.mock.calls.find((c) => String(c[1]).includes("worktree add"))?.[1] ?? "");
    expect(cmd).toMatch(/origin\/.*engineer\/x/);
    expect(cmd).not.toMatch(/origin\/.*main/);
    expect(cmd).not.toMatch(/git fetch /);
  });

  it("no override → cuts from origin/<default> (byte-identical to legacy)", async () => {
    exec.mockResolvedValue(res("Preparing worktree\nRC=0"));
    const base = resolveCheckoutBase({ payload: {}, defaultBase: "main" });
    const r = await createRunWorktree({ sandbox_id: "s", run_id: "abc-123", base });
    expect(r.ok).toBe(true);
    const cmd = String(exec.mock.calls.find((c) => String(c[1]).includes("worktree add"))?.[1] ?? "");
    expect(cmd).toMatch(/origin\/.*main/);
  });
});

describe("run-agent wiring grep-guard", () => {
  it("run-agent resolves the worktree base via resolveCheckoutBase over the default branch", () => {
    const src = read("workers/functions/run-agent.ts");
    expect(src).toContain("resolveCheckoutBase");
    expect(src).toContain("const defaultBase = await step.run(");
    expect(src).toMatch(
      /const base = resolveCheckoutBase\(\{[\s\S]*payload: claim\.payload[\s\S]*defaultBase,[\s\S]*\}\)/,
    );
  });
});
