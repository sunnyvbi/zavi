import { describe, it, expect } from "vitest";
import { fillTraceFromToolResult, LAB_OUTPUT_PREVIEW_BYTES, OUTPUT_PREVIEW_BYTES, type ToolCallTrace } from "../types";

function trace(): Partial<Pick<ToolCallTrace, "output_preview" | "status" | "returned_ids">> {
  return { status: "ok" };
}

describe("fillTraceFromToolResult — SDK returned_ids capture", () => {
  it("captures UUIDs from MCP array content into returned_ids (ok result)", () => {
    const t = trace();
    fillTraceFromToolResult(t, {
      content: [
        {
          type: "text",
          text: "notes: 6ef4bd6d-1111-2222-3333-444455556666 and 7ab1cc99-2222-3333-4444-555566667777",
        },
      ],
    });
    expect(t.returned_ids).toEqual([
      "6ef4bd6d-1111-2222-3333-444455556666",
      "7ab1cc99-2222-3333-4444-555566667777",
    ]);
    expect(t.output_preview).toBeTruthy();
    expect(t.status).toBe("ok");
  });

  it("does NOT set returned_ids on an error result (marks tool_error)", () => {
    const t = trace();
    fillTraceFromToolResult(t, {
      content: [{ type: "text", text: "boom 6ef4bd6d-1111-2222-3333-444455556666" }],
      is_error: true,
    });
    expect(t.status).toBe("tool_error");
    expect(t.returned_ids).toBeUndefined();
  });

  it("C14: captures ONLY UUIDs — raw content (emails/names) never leaks", () => {
    const t = trace();
    fillTraceFromToolResult(t, {
      content: [
        {
          type: "text",
          text: "contact ravi@upcar.ai (John Smith) re note 6ef4bd6d-1111-2222-3333-444455556666",
        },
      ],
    });
    expect(t.returned_ids).toEqual(["6ef4bd6d-1111-2222-3333-444455556666"]);
    const blob = JSON.stringify(t.returned_ids);
    expect(blob).not.toContain("ravi@upcar.ai");
    expect(blob).not.toContain("John Smith");
  });

  it("clears a stale returned_ids if a later fill marks the trace tool_error (mispair/replay)", () => {
    const t = trace();
    fillTraceFromToolResult(t, {
      content: [{ type: "text", text: "6ef4bd6d-1111-2222-3333-444455556666" }],
    });
    expect(t.returned_ids).toEqual(["6ef4bd6d-1111-2222-3333-444455556666"]);
    fillTraceFromToolResult(t, { content: [{ type: "text", text: "boom" }], is_error: true });
    expect(t.returned_ids).toBeUndefined();
    expect(t.status).toBe("tool_error");
  });

  it("returned_ids undefined (not []) when the result has no UUIDs", () => {
    const t = trace();
    fillTraceFromToolResult(t, { content: [{ type: "text", text: "campaign 12345 active" }] });
    expect(t.returned_ids).toBeUndefined();
  });
});

describe("fillTraceFromToolResult — preview cap", () => {
  const big = [{ type: "text", text: `start ${"x".repeat(20_000)} end-figure 136.12` }];

  it("caps the stored preview at 8KB by default (prod)", () => {
    const t = trace();
    fillTraceFromToolResult(t, { content: big });
    expect(t.output_preview!.length).toBeLessThan(OUTPUT_PREVIEW_BYTES + 100);
    expect(t.output_preview).toContain("[truncated");
    expect(t.output_preview).not.toContain("136.12");
  });

  it("keeps the whole result when the lab cap is passed", () => {
    const t = trace();
    fillTraceFromToolResult(t, { content: big }, LAB_OUTPUT_PREVIEW_BYTES);
    expect(t.output_preview).not.toContain("[truncated");
    expect(t.output_preview).toContain("136.12");
  });
});
