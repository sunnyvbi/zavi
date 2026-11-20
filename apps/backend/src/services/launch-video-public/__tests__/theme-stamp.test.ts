import { describe, expect, it } from "vitest";
import { validateGenerateBody } from "../request";

const BODY = {
  email: "founder@acme.com",
  product_name: "Acme",
  one_liner: "Ship faster",
  features: "Fast builds",
  audience: "founders",
  cta_text: "Try it",
  cta_url: "https://acme.com/start",
};

describe("public launch-video theme", () => {
  it("carries the visitor's chosen theme onto the form", () => {
    for (const theme of ["swiss", "editorial", "neon"]) {
      const r = validateGenerateBody({ ...BODY, theme });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.form.theme).toBe(theme);
    }
  });

  it("falls back to swiss rather than rejecting an unknown or absent theme", () => {
    for (const theme of [undefined, "", "vaporwave", 42 as unknown as string]) {
      const r = validateGenerateBody({ ...BODY, theme });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.form.theme).toBe("swiss");
    }
  });

  it("still stamps a tone, because the engine brief requires one", () => {
    const r = validateGenerateBody(BODY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.form.tone).toBe("clean");
  });
});

describe("public launch-video beat inputs", () => {
  it("carries problem and metrics so the problem and metric beats can render", () => {
    const r = validateGenerateBody({
      ...BODY,
      problem: "Renting a car still means a counter, a line, and a markup.",
      metrics: "Teachers|400+\nCities|12",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.form.problem).toContain("counter");
      expect(r.value.form.metrics).toContain("400+");
    }
  });

  it("treats both as optional — empty is legal and just drops those beats", () => {
    const r = validateGenerateBody(BODY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.form.problem).toBe("");
      expect(r.value.form.metrics).toBe("");
    }
  });
});
