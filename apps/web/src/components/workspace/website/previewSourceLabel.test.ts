import { describe, it, expect } from "vitest";
import { previewSourceLabel, previewSource } from "./previewSourceLabel";

describe("previewSource — splits the label prefix from the linkable URL", () => {
  it("returns the marketing URL with a 'Website' prefix", () => {
    expect(previewSource("https://www.upcar.ai", null, null)).toEqual({
      prefix: "Website",
      url: "https://www.upcar.ai",
    });
  });
  it("returns the built-app / building URLs with their prefixes", () => {
    expect(previewSource(null, "https://x.zaviagent.com", null)).toEqual({
      prefix: "Built app",
      url: "https://x.zaviagent.com",
    });
    expect(previewSource(null, null, null, "https://sbx.e2b.app")).toEqual({
      prefix: "Building",
      url: "https://sbx.e2b.app",
    });
  });
  it("returns url:null (nothing to link) when nothing is set", () => {
    expect(previewSource(null, null, null)).toEqual({ prefix: "Website", url: null });
  });
  it("stays in lockstep with the string label", () => {
    const s = previewSource("https://a.com", null, null);
    expect(previewSourceLabel("https://a.com", null, null)).toBe(`${s.prefix}: ${s.url}`);
    expect(previewSourceLabel(null, null, null)).toBe("Website: not set");
  });
});

describe("previewSourceLabel — strip names the URL actually previewed", () => {
  it("prefers the tenant's registered marketing URL", () => {
    expect(
      previewSourceLabel("https://www.upcar.ai", "https://app.zaviagent.com", "https://app.onrender.com"),
    ).toBe("Website: https://www.upcar.ai");
  });

  it("prefers a LIVE built-in URL over the raw onrender host (matches the iframe)", () => {
    expect(
      previewSourceLabel(null, "https://cool-app.zaviagent.com", "https://my-app.onrender.com"),
    ).toBe("Built app: https://cool-app.zaviagent.com");
  });

  it("names the built app without exposing the hosting provider when it has no public address yet", () => {
    expect(previewSourceLabel(null, null, "https://my-app.onrender.com")).toBe("Built app: not published yet");
    expect(previewSource(null, null, "https://my-app.onrender.com")).toEqual({ prefix: "Built app", url: null, note: "not published yet" });
    expect(previewSourceLabel(null, null, "https://my-app.onrender.com")).not.toContain("not set");
    expect(previewSourceLabel(null, null, "https://my-app.onrender.com")).not.toContain("onrender");
  });

  it("still links a built app served from a customer's own domain", () => {
    expect(previewSourceLabel(null, null, "https://app.acme.com")).toBe("Built app: https://app.acme.com");
  });

  it("names the source, so 'Change' is never implied to edit the built-app host", () => {
    expect(previewSourceLabel(null, null, "https://my-app.onrender.com")).toMatch(/^Built app:/);
    expect(previewSourceLabel("https://www.upcar.ai", null, null)).toMatch(/^Website:/);
  });

  it("only says 'not set' when there is genuinely nothing to preview", () => {
    expect(previewSourceLabel(null, null, null)).toBe("Website: not set");
  });

  describe("in-progress build preview (2026-07-27)", () => {
    it("names the build's temporary address rather than claiming 'not set'", () => {
      expect(previewSourceLabel(null, null, null, "https://sbx-3000.e2b.app")).toBe(
        "Building: https://sbx-3000.e2b.app",
      );
    });

    it("labels it distinctly, so a temporary sandbox URL is never sold as the website", () => {
      const label = previewSourceLabel(null, null, null, "https://sbx-3000.e2b.app");
      expect(label).toMatch(/^Building:/);
      expect(label).not.toMatch(/^Website:/);
    });

    it("ranks below every permanent source", () => {
      expect(previewSourceLabel(null, null, "https://a.onrender.com", "https://sbx.e2b.app")).toBe(
        "Built app: not published yet",
      );
      expect(previewSourceLabel(null, "https://a.zaviagent.com", null, "https://sbx.e2b.app")).toBe(
        "Built app: https://a.zaviagent.com",
      );
      expect(previewSourceLabel("https://upcar.ai", null, null, "https://sbx.e2b.app")).toBe(
        "Website: https://upcar.ai",
      );
    });

    it("stays backward-compatible for the three-arg callers", () => {
      expect(previewSourceLabel(null, null, null)).toBe("Website: not set");
    });
  });
});
