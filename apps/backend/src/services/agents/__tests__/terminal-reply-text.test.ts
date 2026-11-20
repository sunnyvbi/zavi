import { describe, it, expect } from "vitest";
import { selectReplyTextFromRow } from "../terminal-reply-text";
import { deriveOutcome } from "../outcome-model";

const row = (over: Partial<Parameters<typeof selectReplyTextFromRow>[0]>) => ({
  status: "success",
  output_text: null,
  error: null,
  parse_error: null,
  agent_slug: "engineer",
  ...over,
});

describe("selectReplyTextFromRow", () => {
  it("success with output_text → that text, not an error", () => {
    const r = selectReplyTextFromRow(row({ status: "success", output_text: "Done: opened PR #5." }));
    expect(r.markdown).toBe("Done: opened PR #5.");
    expect(r.isError).toBe(false);
    expect(r.salvaged).toBe(false);
  });

  it("success with empty output_text → floor copy", () => {
    const r = selectReplyTextFromRow(row({ status: "success", output_text: "" }));
    expect(r.markdown).toBe("Done - no output.");
    expect(r.isError).toBe(false);
  });

  it("parse_failed WITH output_text and NULL error/parse_error → salvages the answer", () => {
    const r = selectReplyTextFromRow(
      row({
        status: "parse_failed",
        output_text:
          "I made changes in the sandbox but the platform refused to ship them: forbidden_path.",
        error: null,
        parse_error: null,
      }),
    );
    expect(r.salvaged).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.markdown).toContain("the platform refused to ship them: forbidden_path");
    expect(r.markdown).not.toMatch(/unknown error/i);
    expect(r.markdown.startsWith("This didn't finish. Nothing was saved. I can try again.")).toBe(true);
    expect(r.markdown).not.toMatch(/⚠|did not finish\.\*\*/);
    expect(r.markdown).not.toMatch(/declared output envelope/i);
  });

  it("non-success (failed) WITH output_text → salvages without the parse-envelope footer", () => {
    const r = selectReplyTextFromRow(
      row({ status: "failed", output_text: "Here is the partial result.", error: null }),
    );
    expect(r.salvaged).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.markdown).toBe("Here is the partial result.");
  });

  it("parse_failed with NO text but a parse_error → genuine failure copy (not salvaged)", () => {
    const r = selectReplyTextFromRow(
      row({ status: "parse_failed", output_text: "", parse_error: "schema mismatch on field X" }),
    );
    expect(r.isError).toBe(true);
    expect(r.salvaged).toBe(false);
    expect(r.markdown).not.toContain("schema mismatch on field X");
    expect(r.markdown).toMatch(/couldn't finish it/i);
  });

  it("failed with NO text and NO error → falls back to the generic failure bubble", () => {
    const r = selectReplyTextFromRow(row({ status: "failed", output_text: "", error: null }));
    expect(r.isError).toBe(true);
    expect(r.markdown).toMatch(/couldn't finish it/i);
  });

  it("infra-reap error (no text) → friendly transient copy, never a raw reap string", () => {
    const r = selectReplyTextFromRow(
      row({
        status: "failed",
        output_text: "",
        error: "boot_reap: orphaned by container restart (worker died mid-run)",
      }),
    );
    expect(r.isError).toBe(true);
    expect(r.markdown).not.toContain("boot_reap");
    expect(r.markdown).toMatch(/temporary|hiccup|try again|re-send/i);
  });
});

describe("selectReplyTextFromRow — outcome path is byte-identical to fallback", () => {
  const cases: Array<{ name: string; row: Partial<Parameters<typeof selectReplyTextFromRow>[0]> }> = [
    { name: "success + text", row: { status: "success", output_text: "Opened PR #5." } },
    { name: "success + empty (floor)", row: { status: "success", output_text: "" } },
    {
      name: "parse_failed + deliverable (incident)",
      row: {
        status: "parse_failed",
        output_text: "I made the change but the platform refused to ship: forbidden_path.",
        error: null,
        parse_error: null,
      },
    },
    {
      name: "parse_failed + parse_error, no text",
      row: { status: "parse_failed", output_text: "", parse_error: "schema mismatch", error: null },
    },
    {
      name: "dispatch_error infra-reap",
      row: {
        status: "dispatch_error",
        output_text: "",
        error: "boot_reap: orphaned by container restart (worker died mid-run)",
      },
    },
    {
      name: "dispatch_error generic (unknown error)",
      row: { status: "dispatch_error", output_text: "", error: null },
    },
    { name: "failed + salvageable text", row: { status: "failed", output_text: "Partial result." } },
    { name: "cancelled", row: { status: "cancelled", output_text: "" } },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const base = row(c.row);
      const legacy = selectReplyTextFromRow({ ...base, outcome: null });
      const withOutcome = selectReplyTextFromRow({
        ...base,
        outcome: deriveOutcome({
          status: base.status ?? "failed",
          outputText: base.output_text,
          error: base.error,
          parseError: base.parse_error,
        }),
      });
      expect(withOutcome).toEqual(legacy);
    });
  }

  it("malformed outcome (no deliverable) on a parse_failed row with output_text → still salvages the row text", () => {
    const r = selectReplyTextFromRow(
      row({
        status: "parse_failed",
        output_text: "Real answer the model produced.",
        error: null,
        parse_error: null,
        outcome: { deliverable: null, side_effect: { kind: "none" }, failure: { class: "envelope", raw_error: null } },
      }),
    );
    expect(r.markdown).toContain("Real answer the model produced.");
    expect(r.markdown).not.toMatch(/unknown error/i);
    expect(r.salvaged).toBe(true);
  });
});
