import { describe, it, expect } from "vitest";
import { PRODUCT_BUILDER_REDIRECT_BASELINE } from "../generic-dispatcher";

describe("PRODUCT_BUILDER_REDIRECT_BASELINE", () => {
  it("forbids every localhost/PORT/dev-default redirect base that caused the P0", () => {
    for (const banned of [
      "req.url",
      "req.nextUrl.origin",
      "process.env.PORT",
      "process.env.APP_URL",
      "process.env.NEXTAUTH_URL",
      "http://localhost:3000",
    ]) {
      expect(PRODUCT_BUILDER_REDIRECT_BASELINE).toContain(banned);
    }
    expect(PRODUCT_BUILDER_REDIRECT_BASELINE).toMatch(/NEVER build an absolute redirect URL/);
  });

  it("prescribes request-origin-relative redirects (relative Location + next/navigation redirect)", () => {
    expect(PRODUCT_BUILDER_REDIRECT_BASELINE).toContain('headers: { Location: "/dashboard" }');
    expect(PRODUCT_BUILDER_REDIRECT_BASELINE).toContain("status: 303");
    expect(PRODUCT_BUILDER_REDIRECT_BASELINE).toContain('next/navigation');
    expect(PRODUCT_BUILDER_REDIRECT_BASELINE).toMatch(/relative/i);
  });

  it("does NOT hardcode any localhost base as the prescribed redirect target", () => {
    expect(PRODUCT_BUILDER_REDIRECT_BASELINE).toMatch(
      /do NOT use `NextResponse\.redirect\(new URL\(path, req\.url\)\)`/,
    );
    expect(PRODUCT_BUILDER_REDIRECT_BASELINE).toMatch(/Success AND error redirects must use the SAME/);
  });

  it("error redirects carry a fixed code, never reflected free text", () => {
    expect(PRODUCT_BUILDER_REDIRECT_BASELINE).not.toMatch(/encodeURIComponent\(msg\)/);
    expect(PRODUCT_BUILDER_REDIRECT_BASELINE).toMatch(/\?error=[a-z_]+"/);
  });
});
