
import { describe, it, expect } from "vitest";
import { capReferenceRefs, REF_CAP_PER_SYMBOL } from "../extract";
import type { RefRow } from "../types";

function ref(symbol: string, kind: RefRow["ref_kind"], line: number): RefRow {
  return {
    symbol_name: symbol,
    ref_kind: kind,
    from_symbol: null,
    file_path: "src/x.ts",
    line,
  };
}

describe("capReferenceRefs (P1 ref cap)", () => {
  it("caps ref_kind='reference' to REF_CAP_PER_SYMBOL per symbol", () => {
    const refs: RefRow[] = [];
    for (let i = 0; i < 120; i++) refs.push(ref("foo", "reference", i));
    for (let i = 0; i < 10; i++) refs.push(ref("bar", "reference", i));

    const out = capReferenceRefs(refs);
    const fooRefs = out.filter((r) => r.symbol_name === "foo" && r.ref_kind === "reference");
    const barRefs = out.filter((r) => r.symbol_name === "bar" && r.ref_kind === "reference");

    expect(fooRefs.length).toBe(REF_CAP_PER_SYMBOL);
    expect(barRefs.length).toBe(10);
  });

  it("never caps ref_kind='call' refs (code_callers stays complete)", () => {
    const refs: RefRow[] = [];
    for (let i = 0; i < 500; i++) refs.push(ref("doThing", "call", i));

    const out = capReferenceRefs(refs);
    const calls = out.filter((r) => r.ref_kind === "call");
    expect(calls.length).toBe(500);
  });

  it("caps references but leaves calls intact when both target the same symbol", () => {
    const refs: RefRow[] = [];
    for (let i = 0; i < 200; i++) refs.push(ref("svc", "reference", i));
    for (let i = 0; i < 200; i++) refs.push(ref("svc", "call", i));

    const out = capReferenceRefs(refs);
    const refsOut = out.filter((r) => r.symbol_name === "svc" && r.ref_kind === "reference");
    const callsOut = out.filter((r) => r.symbol_name === "svc" && r.ref_kind === "call");

    expect(refsOut.length).toBe(REF_CAP_PER_SYMBOL);
    expect(callsOut.length).toBe(200);
  });

  it("keeps the first N references (stable across re-index of unchanged code)", () => {
    const refs: RefRow[] = [];
    for (let i = 0; i < 100; i++) refs.push(ref("foo", "reference", i));

    const out = capReferenceRefs(refs).filter((r) => r.ref_kind === "reference");
    expect(out.map((r) => r.line)).toEqual(
      Array.from({ length: REF_CAP_PER_SYMBOL }, (_, i) => i),
    );
  });
});
