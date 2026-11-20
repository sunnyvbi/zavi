
import { describe, it, expect } from "vitest";
import { renderWelcomeEmail } from "../welcome";

describe("renderWelcomeEmail", () => {
  const args = {
    displayName: "Acme Robotics",
    workspaceUrl: "https://www.zaviagent.com/workspace",
  };

  it("includes the company name in subject + intro", () => {
    const r = renderWelcomeEmail(args);
    expect(r.subject).toContain("Acme Robotics");
    expect(r.html).toContain("Acme Robotics");
    expect(r.text).toContain("Acme Robotics");
  });

  it("the CTA opens the growth plan in html + text", () => {
    const r = renderWelcomeEmail(args);
    expect(r.html).toContain("https://www.zaviagent.com/workspace?tab=growth-strategy");
    expect(r.text).toContain("Start my growth plan: https://www.zaviagent.com/workspace?tab=growth-strategy");
  });

  it("keeps Slack as a secondary link", () => {
    const r = renderWelcomeEmail(args);
    expect(r.html).toContain("https://www.zaviagent.com/workspace?tab=settings#connector-slack");
    expect(r.text).toContain("https://www.zaviagent.com/workspace?tab=settings#connector-slack");
  });

  it("leads with growth, not the retired cofounder/agent-team framing", () => {
    const r = renderWelcomeEmail(args);
    expect(r.subject.toLowerCase()).toContain("growth");
    for (const part of [r.subject, r.html, r.text]) {
      expect(part.toLowerCase()).not.toContain("cofounder");
      expect(part.toLowerCase()).not.toContain("agent team");
    }
  });
});
