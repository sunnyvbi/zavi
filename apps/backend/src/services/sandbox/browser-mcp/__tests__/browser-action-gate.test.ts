import { describe, it, expect } from "vitest";
import {
  classifyBrowserOp,
  buildBrowserActionBody,
  buildBrowserActionEvidence,
} from "../browser-action-gate";
import type { DaemonOp } from "../types";
import { decisionEvidenceSchema } from "@/services/agents/decision-evidence";

describe("classifyBrowserOp — read vs write", () => {
  it("classifies WRITE ops (page-mutating) as write — gated", () => {
    expect(classifyBrowserOp({ op: "click", selector: "#post" })).toBe("write");
    expect(
      classifyBrowserOp({ op: "fill", selector: "#email", value: "x@y.z" }),
    ).toBe("write");
  });

  it("classifies all READ/NAV ops as read — execute inline", () => {
    const reads: DaemonOp[] = [
      { op: "nav", url: "https://instagram.com" },
      { op: "text", selector: "#caption" },
      { op: "assert_text", selector: "#h1", expected: "Welcome" },
      { op: "assert_url", expected: "https://x.com/home" },
      { op: "screenshot" },
      { op: "wait_for", selector: "#loaded" },
    ];
    for (const op of reads) {
      expect(classifyBrowserOp(op), `${op.op} should be read`).toBe("read");
    }
  });

  it("DEFAULTS TO WRITE for an unknown/future op (fail toward gating)", () => {
    expect(classifyBrowserOp({ op: "evaluate" } as { op: string })).toBe("write");
    expect(classifyBrowserOp({ op: "__future_write__" } as { op: string })).toBe(
      "write",
    );
    expect(classifyBrowserOp({ op: "press_key" } as { op: string })).toBe(
      "write",
    );
    expect(classifyBrowserOp({ op: "upload_file" } as { op: string })).toBe(
      "write",
    );
  });

  it("DEFAULTS TO WRITE for a malformed op (missing/non-string op name)", () => {
    expect(classifyBrowserOp({} as { op?: string })).toBe("write");
    expect(classifyBrowserOp({ op: 123 } as unknown as { op?: unknown })).toBe(
      "write",
    );
    expect(
      classifyBrowserOp({ op: null } as unknown as { op?: unknown }),
    ).toBe("write");
    expect(
      classifyBrowserOp(undefined as unknown as { op?: unknown }),
    ).toBe("write");
  });
});

describe("buildBrowserActionBody — persisted decision body (no page content)", () => {
  it("captures op + selector + value for a fill", () => {
    const body = buildBrowserActionBody({
      op: "fill",
      selector: "#search",
      value: "rental car SF",
    });
    expect(body).toEqual({ op: "fill", selector: "#search", value: "rental car SF" });
  });

  it("captures op + selector for a click (no value)", () => {
    const body = buildBrowserActionBody({ op: "click", selector: "#submit" });
    expect(body).toEqual({ op: "click", selector: "#submit" });
    expect(body).not.toHaveProperty("value");
  });

  it("preserves a forged/unknown op name (so the gate still records it)", () => {
    const body = buildBrowserActionBody({ op: "evaluate", selector: "body" } as {
      op: string;
      selector: string;
    });
    expect(body.op).toBe("evaluate");
    expect(body.selector).toBe("body");
  });

  it("length-caps selector + value so the decision body stays bounded", () => {
    const body = buildBrowserActionBody({
      op: "fill",
      selector: "a".repeat(5000),
      value: "b".repeat(20000),
    });
    expect(body.selector!.length).toBe(2000);
    expect(body.value!.length).toBe(8000);
  });

  it("drops non-string selector/value rather than persist garbage", () => {
    const body = buildBrowserActionBody({
      op: "click",
      selector: { evil: true },
    } as unknown as { op: string });
    expect(body).toEqual({ op: "click" });
  });
});

describe("buildBrowserActionEvidence — C-1 activation envelope", () => {
  it("produces a schema-valid, conservative envelope from the action body", () => {
    const ev = buildBrowserActionEvidence({ op: "click", selector: "#post" });
    expect(() => decisionEvidenceSchema.parse(ev)).not.toThrow();
    expect(ev.reversibility).toBe("irreversible");
    expect(ev.blast_radius).toBe("ORANGE");
    expect(ev.confidence).toBe(0.5);
    expect(ev.alternatives_considered).toEqual([]);
    expect(ev.evidence).toContain("op: click");
    expect(ev.evidence).toContain("selector: #post");
    expect(ev.reason_text).toContain("click");
  });

  it("omits selector/url lines when absent", () => {
    const ev = buildBrowserActionEvidence({ op: "evaluate" });
    expect(ev.evidence).toEqual(["op: evaluate"]);
  });
});
