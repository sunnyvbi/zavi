
import { describe, it, expect } from "vitest";
import { renderWelcomeBuildEmail } from "../welcome-build";

describe("renderWelcomeBuildEmail", () => {
  const args = {
    displayName: "Acme Robotics",
    buildUrl: "https://www.zaviagent.com/workspace?tab=build&build=11111111-1111-4111-8111-111111111111",
  };

  it("includes the company name in subject + intro", () => {
    const r = renderWelcomeBuildEmail(args);
    expect(r.subject).toContain("Acme Robotics");
    expect(r.html).toContain("Acme Robotics");
    expect(r.text).toContain("Acme Robotics");
  });

  it("wires the build CTA URL into html + text", () => {
    const r = renderWelcomeBuildEmail(args);
    expect(r.html).toContain("build=11111111-1111-4111-8111-111111111111");
    expect(r.text).toContain(args.buildUrl);
  });

  it("uses build-variant copy, not the growth-plan copy", () => {
    const r = renderWelcomeBuildEmail(args);
    expect(r.subject.toLowerCase()).toContain("building");
    expect(r.html.toLowerCase()).toContain("building");
    expect(r.html.toLowerCase()).not.toContain("company brain");
  });

  it("returns non-empty html + text + subject", () => {
    const r = renderWelcomeBuildEmail(args);
    expect(r.subject.length).toBeGreaterThan(0);
    expect(r.html.length).toBeGreaterThan(0);
    expect(r.text.length).toBeGreaterThan(0);
  });
});
