import { describe, it, expect } from "vitest";
import { PRODUCT_BUILDER_SESSION_SECRET_BASELINE } from "../generic-dispatcher";

describe("PRODUCT_BUILDER_SESSION_SECRET_BASELINE", () => {
  it("mandates reading process.env.SESSION_SECRET as the signing key", () => {
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toContain("process.env.SESSION_SECRET");
  });

  it("FORBIDS a hardcoded-default fallback (the exact shape that caused the takeover)", () => {
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toMatch(/NEVER `process\.env\.SESSION_SECRET \|\| '<anything>'`/);
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toMatch(/NEVER `\?\? '<anything>'`/);
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toMatch(/never a hardcoded default/i);
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).not.toMatch(
      /const secret = process\.env\.SESSION_SECRET \|\| ['"`][^'"`]+['"`];?\s*$/m,
    );
  });

  it("mandates FAIL-CLOSED: throw when the secret is missing/empty", () => {
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toMatch(/FAIL CLOSED/);
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toMatch(/throw new Error\(['"`]SESSION_SECRET is not set/);
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toMatch(/THROWS when it is missing\/empty/);
  });

  it("is BUILD-SAFE: forbids a module-top-level throw (next build runs before SESSION_SECRET exists)", () => {
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toMatch(/BUILD-SAFE/);
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toMatch(/do NOT throw at module top-level/i);
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toMatch(/next build/);
  });

  it("mandates the session token carry an expiry", () => {
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toMatch(/token MUST carry an expiry/);
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toContain("exp");
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toMatch(/reject an expired token/i);
  });

  it("keeps the secret SERVER-ONLY (never NEXT_PUBLIC_, never sent to the browser)", () => {
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toMatch(/SERVER-ONLY/);
    expect(PRODUCT_BUILDER_SESSION_SECRET_BASELINE).toMatch(/never send it to the browser/i);
  });
});
