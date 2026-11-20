import { describe, expect, it } from "vitest";
import { CTA_RE, MEASURE_SCRIPT } from "../checks/render";

describe("call-to-action button text", () => {
  it.each(["Sign up", "Sign-up", "Signup", "SIGN-UP free", "Get started", "Book now", "Réserver"])("counts %s", (text) => {
    expect(CTA_RE.test(text)).toBe(true);
  });

  it.each(["About us", "Our story", "Signal"])("does not count %s", (text) => {
    expect(CTA_RE.test(text)).toBe(false);
  });

  it("is the pattern the in-page script uses", () => {
    const line = MEASURE_SCRIPT.split("\n").find((l) => l.includes("const CTA ="))!;
    const inPage = new Function(`${line.trim()} return CTA;`)() as RegExp;
    expect(inPage.test("Sign-up")).toBe(true);
    expect(inPage.source).toBe(CTA_RE.source);
  });
});
