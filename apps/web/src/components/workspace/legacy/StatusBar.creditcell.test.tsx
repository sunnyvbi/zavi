
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBar } from "./StatusBar";
import { EMPTY_COUNTERS } from "../counters";

const base = { ...EMPTY_COUNTERS };
const html = (counters: object, loaded = true) =>
  renderToStaticMarkup(React.createElement(StatusBar, { counters: counters as never, loaded }));

describe("StatusBar — credit burn-down cell", () => {
  it("hides the Credits cell while metering is dark (credits_enforced=false)", () => {
    const out = html({ ...base, credits_enforced: false, credits_remaining: 38500 });
    expect(out).not.toContain("Credits");
    for (const l of ["Drift", "Today", "Active", "Pending"]) expect(out).toContain(l);
  });

  it("shows the Credits cell with a compact balance when enforced", () => {
    const out = html({ ...base, credits_enforced: true, credits_remaining: 38500 });
    expect(out).toContain("Credits");
    expect(out).toContain("38.5k");
  });

  it("formats millions compactly", () => {
    expect(html({ ...base, credits_enforced: true, credits_remaining: 2_000_000 })).toContain("2M");
  });

  it("shows — when balance is unknown (null), even if enforced", () => {
    const out = html({ ...base, credits_enforced: true, credits_remaining: null });
    expect(out).toContain("Credits");
    expect(out).toContain("-");
  });

  it("never throws + hides Credits on a malformed/partial counters object", () => {
    expect(() => html({} as object)).not.toThrow();
    expect(html({})).not.toContain("Credits");
  });

  it("does not show the live value before the first poll resolves (loaded=false)", () => {
    const out = html({ ...base, credits_enforced: true, credits_remaining: 38500 }, false);
    expect(out).toContain("Credits");
    expect(out).not.toContain("38.5k");
  });
});
