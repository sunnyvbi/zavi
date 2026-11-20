
import { describe, it, expect } from "vitest";
import { greetingName, renderOnboardingSequenceEmail } from "../onboarding-sequence";
import { renderEmail } from "../../theme";
import { SEQUENCE_STEPS, stepByNumber } from "@/services/onboarding-emails/steps";

const base = {
  workspaceUrl: "https://www.zaviagent.com/workspace",
  imageBaseUrl: "https://www.zaviagent.com",
  unsubscribeUrl: "https://api.zaviagent.com/api/onboarding-emails/unsubscribe?t=abc",
};
const render = (step: number, firstName = "Priya") =>
  renderOnboardingSequenceEmail({ ...base, step: stepByNumber(step)!, firstName });

describe("greetingName", () => {
  it("takes the first word of a person's name", () => {
    expect(greetingName("Priya Nair")).toBe("Priya");
  });
  it("falls back to 'there' when there is no usable name", () => {
    for (const bad of [null, undefined, "", "   ", "priya@acme.com", "<b>x</b>", "!!!"]) {
      expect(greetingName(bad as string | null | undefined)).toBe("there");
    }
  });
  it("cannot carry a line break into the greeting", () => {
    expect(greetingName("Priya\r\nBcc: x@y.z")).toBe("Priya");
  });
});

describe("renderOnboardingSequenceEmail", () => {
  it("greets by first name, in html and text", () => {
    const r = render(2);
    expect(r.html).toContain("Hi Priya,");
    expect(r.text.startsWith("Hi Priya,")).toBe(true);
  });

  it("escapes a hostile name instead of injecting markup", () => {
    const r = render(2, `<script>alert(1)</script>`);
    expect(r.html).not.toContain("<script>alert(1)");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("every email has a working button, a picture with alt text, and an unsubscribe link", () => {
    for (const s of SEQUENCE_STEPS) {
      const r = renderOnboardingSequenceEmail({ ...base, step: s, firstName: "Priya" });
      expect(r.html, `button ${s.step}`).toMatch(new RegExp(`<a href="https://www\\.zaviagent\\.com/workspace[^"]*"[^>]*>${s.button}</a>`));
      expect(r.html, `image ${s.step}`).toContain(`src="https://www.zaviagent.com/email/onboarding/${s.image}"`);
      expect(r.html, `alt ${s.step}`).toContain(`alt="${s.alt}"`);
      expect(r.html, `unsub ${s.step}`).toContain(`href="${base.unsubscribeUrl}"`);
      expect(r.text, `text unsub ${s.step}`).toContain(`Unsubscribe: ${base.unsubscribeUrl}`);
      expect(r.subject).toBe(s.subject);
    }
  });

  it("puts the sign-off after the button, and the plan-wait line only on the welcome", () => {
    const line = "Your growth plan will be ready in about 15 minutes. I’ll email you when it is.";
    const welcome = render(1).html;
    expect(welcome.indexOf("Open Zavi")).toBeLessThan(welcome.indexOf(line));
    expect(welcome.indexOf(line)).toBeLessThan(welcome.lastIndexOf("AI Growth Agent For Your Business"));
    expect(render(1).text).toContain(line);
    expect(render(3).html).not.toContain(line);
  });

  it("shows the preview text only when the email has one", () => {
    expect(render(2).html).toContain("Give me a goal and let Autopilot");
  });

  it("the Growth Strategy and channel buttons point at the right tab", () => {
    expect(render(2).html).toContain("workspace?tab=growth-strategy");
    expect(render(3).html).toContain("workspace?tab=channels&amp;channel=seo&amp;src=onb_3");
  });

  it("every button and its plain-text link carry the email's own number", () => {
    for (const s of SEQUENCE_STEPS) {
      const r = renderOnboardingSequenceEmail({ ...base, step: s, firstName: "Priya" });
      expect(r.html, `button ${s.step}`).toMatch(new RegExp(`[?;]src=onb_${s.step}"[^>]*>${s.button}</a>`));
      expect(r.text, `text ${s.step}`).toContain(`src=onb_${s.step}`);
    }
  });
});

describe("theme additions are opt-in", () => {
  const plain = renderEmail({ title: "Hello", body: "<p>hi</p>", footerVariant: "neutral" });
  it("an email that passes none of them has no picture and no unsubscribe link", () => {
    expect(plain).not.toContain("<img");
    expect(plain).not.toContain("Unsubscribe");
  });
});
