
import { describe, it, expect, vi } from "vitest";
import {
  classifyTypecheck,
  extractTypecheckReceipt,
  typecheckVerdictWithFinalCheck,
  type TypecheckReceipt,
} from "../typecheck-receipt";
import { collectVerificationNotes } from "../ship-gate";

const mcp = (o: unknown) => [{ type: "text", text: JSON.stringify(o) }];
const tcResult = (status: string, extra: Record<string, unknown> = {}) => ({
  status,
  command: "npm run typecheck --silent",
  exit_code: status === "passed" ? 0 : status === "failed" ? 2 : null,
  error_count: status === "failed" ? 2 : 0,
  errors:
    status === "failed"
      ? ["src/a.ts(3,5): error TS2322: Type 'x' is not assignable.", "src/b.ts(1,1): error TS2307: Cannot find module 'y'."]
      : [],
  truncated: false,
  ...extra,
});
const bash = (status: "passed" | "failed", command = "npx tsc --noEmit"): TypecheckReceipt => ({
  tool: "run_bash",
  attempted: true,
  exit_code: status === "passed" ? 0 : 1,
  status,
  command,
});

describe("extractTypecheckReceipt for run_typecheck", () => {
  it("reads the status, exit code and errors from the MCP-wrapped result", () => {
    const r = extractTypecheckReceipt("mcp__sandbox__run_typecheck", mcp(tcResult("failed")), false);
    expect(r).toMatchObject({
      platform: true,
      status: "failed",
      exit_code: 2,
      error_count: 2,
      command: "npm run typecheck --silent",
    });
    expect(r?.errors?.[0]).toContain("TS2322");
  });

  it("a tool error or an unreadable result is couldnt_run, never failed", () => {
    expect(extractTypecheckReceipt("run_typecheck", mcp(tcResult("failed")), true)?.status).toBe("couldnt_run");
    expect(extractTypecheckReceipt("sandbox__run_typecheck", "not json", false)?.status).toBe("couldnt_run");
    expect(extractTypecheckReceipt("run_typecheck", mcp(tcResult("couldnt_run")), false)?.status).toBe(
      "couldnt_run",
    );
  });
});

describe("classifyTypecheck: the last platform verdict wins", () => {
  const p = (status: string) => extractTypecheckReceipt("run_typecheck", tcResult(status), false)!;

  it("failed then passed -> passed (the agent fixed the errors and re-ran it)", () => {
    expect(classifyTypecheck([p("failed"), p("passed")]).status).toBe("passed");
  });

  it("passed then failed -> failed, with the error count and errors", () => {
    const v = classifyTypecheck([p("passed"), p("failed")]);
    expect(v).toMatchObject({ status: "failed", error_count: 2 });
    expect(v.errors).toHaveLength(2);
  });

  it("a platform pass overrides an earlier red run_bash typecheck", () => {
    expect(classifyTypecheck([bash("failed"), p("passed")]).status).toBe("passed");
  });

  it("a platform couldnt_run carries no verdict, so the run_bash receipts decide", () => {
    expect(classifyTypecheck([bash("failed"), p("couldnt_run")]).status).toBe("failed");
    expect(classifyTypecheck([bash("passed"), p("couldnt_run")]).status).toBe("passed");
  });
});

describe("typecheckVerdictWithFinalCheck (post-run fallback)", () => {
  const tsFile = [{ path: "apps/web/src/a.tsx", action: "modify" }];
  const platform = (status: string) => ({
    name: "mcp__sandbox__run_typecheck",
    typecheck_receipt: extractTypecheckReceipt("run_typecheck", tcResult(status), false),
  });
  const edit = { name: "mcp__sandbox__str_replace" };
  const bashTrace = (status: "passed" | "failed") => ({ name: "mcp__sandbox__run_bash", typecheck_receipt: bash(status) });

  it("runs once when TS files changed and no run_typecheck receipt exists", async () => {
    const runFinal = vi.fn(async () => tcResult("failed"));
    const out = await typecheckVerdictWithFinalCheck({ traces: [edit], files: tsFile, runFinal });
    expect(runFinal).toHaveBeenCalledTimes(1);
    expect(out.ranFinal).toBe(true);
    expect(out.verdict).toMatchObject({ status: "failed", error_count: 2 });
  });

  it("does not run when run_typecheck was the model's last word on the files", async () => {
    const runFinal = vi.fn(async () => tcResult("failed"));
    const out = await typecheckVerdictWithFinalCheck({ traces: [edit, platform("passed")], files: tsFile, runFinal });
    expect(runFinal).not.toHaveBeenCalled();
    expect(out.verdict.status).toBe("passed");
  });

  it("re-runs when files were edited after the last run_typecheck, and a stale pass does not stand", async () => {
    const runFinal = vi.fn(async () => tcResult("failed"));
    const out = await typecheckVerdictWithFinalCheck({
      traces: [platform("passed"), edit],
      files: tsFile,
      runFinal,
    });
    expect(runFinal).toHaveBeenCalledTimes(1);
    expect(out.verdict.status).toBe("failed");
  });

  it("a stale platform failure does not stand when the re-run could not run", async () => {
    const out = await typecheckVerdictWithFinalCheck({
      traces: [platform("failed"), edit],
      files: tsFile,
      runFinal: async () => tcResult("couldnt_run"),
    });
    expect(out.verdict.status).toBe("couldnt_run");
  });

  it("build-pipeline runs skip it, so a red check can never reach the build gate", async () => {
    const runFinal = vi.fn(async () => tcResult("failed"));
    const out = await typecheckVerdictWithFinalCheck({ traces: [edit], files: tsFile, runFinal, pipelineRun: true });
    expect(runFinal).not.toHaveBeenCalled();
    expect(out.verdict.status).toBe("not_run");
  });

  it("build-pipeline runs keep a model-called red run_typecheck: build_ok is false despite typecheck_ok:true", async () => {
    const runFinal = vi.fn(async () => tcResult("passed"));
    const out = await typecheckVerdictWithFinalCheck({
      traces: [edit, platform("failed")],
      files: tsFile,
      runFinal,
      pipelineRun: true,
    });
    expect(runFinal).not.toHaveBeenCalled();
    expect(out.verdict.status).toBe("failed");
    const typecheckOk = true;
    const buildOk =
      out.verdict.status === "failed" ? false : out.verdict.status === "passed" ? true : typecheckOk;
    expect(buildOk).toBe(false);
  });

  it("build-pipeline runs still honour the model's run_bash typecheck, as on main", async () => {
    const out = await typecheckVerdictWithFinalCheck({
      traces: [bashTrace("failed")],
      files: tsFile,
      runFinal: async () => tcResult("passed"),
      pipelineRun: true,
    });
    expect(out.verdict.status).toBe("failed");
  });

  it("does not run when no .ts/.tsx file was added or edited", async () => {
    const runFinal = vi.fn(async () => tcResult("failed"));
    const out = await typecheckVerdictWithFinalCheck({
      traces: [edit],
      files: [
        { path: "README.md", action: "modify" },
        { path: "src/gone.ts", action: "delete" },
      ],
      runFinal,
    });
    expect(runFinal).not.toHaveBeenCalled();
    expect(out.verdict.status).toBe("not_run");
  });

  it("a throw in the final check is couldnt_run; an earlier narrower model pass does not become passed", async () => {
    const out = await typecheckVerdictWithFinalCheck({
      traces: [bashTrace("passed")],
      files: tsFile,
      runFinal: async () => {
        throw new Error("sandbox gone");
      },
    });
    expect(out.verdict.status).toBe("couldnt_run");
  });

  it("a final check that left a changed package unchecked is couldnt_run, even after a model pass", async () => {
    const out = await typecheckVerdictWithFinalCheck({
      traces: [bashTrace("passed")],
      files: [
        { path: "a/src/x.ts", action: "modify" },
        { path: "b/src/y.ts", action: "modify" },
      ],
      runFinal: async () => tcResult("couldnt_run", { reason: "no typecheck command for b" }),
    });
    expect(out.verdict.status).toBe("couldnt_run");
  });

  it("a model run_bash failure still stands when the final check could not run", async () => {
    const out = await typecheckVerdictWithFinalCheck({
      traces: [bashTrace("failed")],
      files: tsFile,
      runFinal: async () => tcResult("couldnt_run"),
    });
    expect(out.verdict.status).toBe("failed");
  });

  it("the final platform result wins over an earlier run_bash failure", async () => {
    const out = await typecheckVerdictWithFinalCheck({
      traces: [bashTrace("failed")],
      files: tsFile,
      runFinal: async () => tcResult("passed"),
    });
    expect(out.verdict.status).toBe("passed");
  });
});

describe("PR note reads the server typecheck verdict", () => {
  const typecheckNotes = (env: Record<string, unknown>) =>
    collectVerificationNotes(env).filter((n) => n.startsWith("Typecheck"));

  it("server failed -> warns with the error count and the first errors", () => {
    const [note] = typecheckNotes({
      typecheck_ok: true,
      typecheck_verify: classifyTypecheck([
        extractTypecheckReceipt("run_typecheck", tcResult("failed"), false)!,
      ]),
    });
    expect(note).toContain("FAILED");
    expect(note).toContain("2 errors");
    expect(note).toContain("TS2322");
    expect(note).toContain("TS2307");
  });

  it("server passed -> no typecheck warning even when the model said false", () => {
    expect(typecheckNotes({ typecheck_ok: false, typecheck_verify: { status: "passed", attempts: 1 } })).toEqual([]);
  });

  it("no server verdict -> falls back to the model's typecheck_ok", () => {
    expect(typecheckNotes({ typecheck_ok: false, typecheck_verify: { status: "not_run", attempts: 0 } })).toHaveLength(1);
    expect(typecheckNotes({ typecheck_ok: false })).toHaveLength(1);
    expect(typecheckNotes({ typecheck_ok: true })).toEqual([]);
  });
});
