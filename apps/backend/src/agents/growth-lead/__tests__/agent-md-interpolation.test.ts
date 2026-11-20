import { readFileSync } from "node:fs";
import path from "node:path";

import matter from "gray-matter";
import { describe, expect, it } from "vitest";

import {
  interpolate,
  UnresolvedPlaceholderError,
} from "../../../services/agents/template";

const AGENT_MD = path.join(__dirname, "..", "agent.md");

function loadBody(): string {
  return matter(readFileSync(AGENT_MD, "utf-8")).content;
}

const RENDER_CTX = {
  tenant: { display_name: "Acme", slug: "acme" },
  memory: {
    company: "(company memory)",
    ops: "(ops memory)",
    policies: "",
    disputes: "",
    support: "",
  },
};

describe("growth-lead agent.md interpolation", () => {
  it("renders through interpolate() without an UnresolvedPlaceholderError", () => {
    const body = loadBody();
    expect(() => interpolate(body, RENDER_CTX)).not.toThrow();
  });

  it("contains no double-brace mustache tokens other than the resolvable {{ memory.* }} anchors", () => {
    const body = loadBody();
    const tokens = [...body.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) =>
      m[1].trim(),
    );
    const allowed = new Set(["memory.company", "memory.ops"]);
    const offenders = tokens.filter((t) => !allowed.has(t));
    expect(offenders).toEqual([]);
  });

  it("the worked-example email draft uses single-bracket merge fields", () => {
    const body = loadBody();
    expect(body).toContain("[first_name]");
    expect(body).toContain("[paywall_url]");
    expect(body).not.toMatch(/\{\{\s*first_name\s*\}\}/);
    expect(body).not.toMatch(/\{\{\s*paywall_url\s*\}\}/);
  });
});

describe("growth-lead agent.md — constraint-first bet rubric", () => {
  it("has the constraint-first bet rubric section", () => {
    expect(loadBody()).toMatch(/## Constraint-first bet rubric/);
  });
  it("states the never-supply-into-no-demand rule", () => {
    expect(loadBody()).toMatch(/NEVER propose adding supply/);
  });
});

describe("growth-lead liquidity_gap rubric (honest supply-pressure framing)", () => {
  const body = loadBody();

  it("frames liquidity_gap as a supply-pressure proxy, not unmet demand", () => {
    expect(body).toContain("growth__liquidity_gap");
    expect(body).toMatch(/supply-pressure proxy/i);
    expect(body).toMatch(/not true unmet demand/i);
  });

  it("keeps the deferred not_available path AND the HOLD-without-demand default", () => {
    expect(body).toContain("liquidity_not_available");
    expect(body).toMatch(/default any supply-side or new-geo bet to HOLD/i);
  });

  it("no longer references the retired liquidity_not_connected stub error", () => {
    expect(body).not.toContain("liquidity_not_connected");
  });

  it("does not frame liquidity_gap as a plain supply/demand gap (the old constraint-line wording)", () => {
    expect(body).not.toMatch(/`growth__liquidity_gap`\s*\(supply\/demand gap\)/);
    expect(body).toMatch(/NOT a true supply\/demand gap/i);
  });
});

describe("interpolate() fail-loud is preserved (control)", () => {
  it("still throws on an unresolved mustache token in the template", () => {
    expect(() =>
      interpolate("Hi {{first_name}} — upgrade: {{paywall_url}}", RENDER_CTX),
    ).toThrow(UnresolvedPlaceholderError);
  });
});
