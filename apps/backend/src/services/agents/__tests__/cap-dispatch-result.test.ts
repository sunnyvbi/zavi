import { describe, it, expect } from "vitest";
import {
  capDispatchResultForInngest,
  INNGEST_STEP_RETURN_BUDGET_BYTES,
} from "@/services/agents/cap-dispatch-result";
import type { DispatcherResult } from "@/services/agents/types";

function base(over: Partial<DispatcherResult> = {}): DispatcherResult {
  return {
    output_text: "Opened PR #42 — added the /todos CRUD API.",
    parsed: { repo: "o/r", head_branch: "engineer/run-1", title: "feat", files: [] },
    parse_ok: true,
    raw_response_text: "short raw",
    prompt_snapshot: "short prompt",
    usage: { input_tokens: 10, output_tokens: 20 },
    ...over,
  } as DispatcherResult;
}

const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x), "utf8");

describe("capDispatchResultForInngest", () => {
  it("returns the SAME reference unchanged when under budget (small runs untouched)", () => {
    const r = base();
    const out = capDispatchResultForInngest(r);
    expect(out).toBe(r);
  });

  it("trims an oversized engineer result UNDER budget", () => {
    const bigContent = "x".repeat(700 * 1024);
    const r = base({
      parsed: {
        repo: "o/r",
        head_branch: "engineer/run-1",
        title: "big build",
        files: [
          { path: "src/a.ts", action: "create", content: bigContent },
          { path: "src/b.ts", action: "create", content: "y".repeat(400 * 1024) },
        ],
      },
      raw_response_text: bigContent,
    });
    expect(bytes(r)).toBeGreaterThan(INNGEST_STEP_RETURN_BUDGET_BYTES);

    const out = capDispatchResultForInngest(r);
    expect(bytes(out)).toBeLessThanOrEqual(INNGEST_STEP_RETURN_BUDGET_BYTES);
  });

  it("preserves output_text + parsed STRUCTURE (paths/keys) while eliding file bodies", () => {
    const big = "z".repeat(900 * 1024);
    const r = base({
      output_text: "the user-facing answer that must survive",
      parsed: {
        repo: "o/r",
        head_branch: "engineer/run-1",
        title: "t",
        files: [{ path: "src/keep-this-path.ts", action: "create", content: big, diff: big }],
      },
    });
    const out = capDispatchResultForInngest(r);
    expect(out.output_text).toBe("the user-facing answer that must survive");
    const files = (out.parsed as { files: Array<Record<string, unknown>> }).files;
    expect(files[0].path).toBe("src/keep-this-path.ts");
    expect(files[0].action).toBe("create");
    expect(String(files[0].content)).toContain("elided");
    expect(String(files[0].content).length).toBeLessThan(big.length);
    expect(String(files[0].diff)).toContain("elided");
    expect((out.parsed as { repo: string }).repo).toBe("o/r");
    expect((out.parsed as { title: string }).title).toBe("t");
  });

  it("caps raw_response_text/prompt_snapshot when file-elision alone isn't enough", () => {
    const big = "q".repeat(800 * 1024);
    const r = base({
      parsed: { repo: "o/r", head_branch: "engineer/x", title: "t", files: [] },
      raw_response_text: big,
      prompt_snapshot: big,
    });
    const out = capDispatchResultForInngest(r);
    expect(bytes(out)).toBeLessThanOrEqual(INNGEST_STEP_RETURN_BUDGET_BYTES);
    expect(out.raw_response_text.length).toBeLessThan(big.length);
    expect(out.raw_response_text).toContain("truncated");
    expect(out.output_text).toBe(r.output_text);
  });

  it("does not touch a non-engineer (fileless) parsed envelope's structure", () => {
    const r = base({ parsed: { kind: "digest", summary: "ok", items: [1, 2, 3] } });
    const out = capDispatchResultForInngest(r);
    expect(out).toBe(r);
    expect(out.parsed).toEqual({ kind: "digest", summary: "ok", items: [1, 2, 3] });
  });
});
