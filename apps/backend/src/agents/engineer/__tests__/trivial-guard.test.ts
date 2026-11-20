
import { describe, it, expect } from "vitest";
import {
  isServerTrivial,
  effectiveRiskClass,
  TRIVIAL_MAX_CHANGED_LINES,
  type TrivialGuardFile,
} from "../trivial-guard";

const modify = (path: string, changed: number): TrivialGuardFile => ({
  path,
  action: "modify",
  diff: [
    "@@ -1,1 +1,1 @@",
    ...Array.from({ length: changed }, (_, i) => `+line ${i}`),
  ].join("\n"),
});

describe("trivial-guard — isServerTrivial", () => {
  it("a tiny copy/doc change with no code files IS trivial", () => {
    expect(
      isServerTrivial({ files: [modify("README.md", 3), modify("apps/web/src/Hero.tsx", 2)] }),
    ).toBe(true);
  });

  it("an HTTP route change is NEVER trivial", () => {
    expect(
      isServerTrivial({ files: [modify("apps/web/src/Hero.tsx", 2)], httpRouteChanged: true }),
    ).toBe(false);
  });

  it("touching a test/spec file is NEVER trivial", () => {
    expect(isServerTrivial({ files: [modify("apps/backend/src/foo.test.ts", 1)] })).toBe(false);
  });

  it("touching a dependency manifest is NEVER trivial", () => {
    expect(isServerTrivial({ files: [modify("package.json", 1)] })).toBe(false);
    expect(isServerTrivial({ files: [modify("apps/web/pnpm-lock.yaml", 1)] })).toBe(false);
  });

  it("touching a config file is NEVER trivial", () => {
    expect(isServerTrivial({ files: [modify("tsconfig.json", 1)] })).toBe(false);
    expect(isServerTrivial({ files: [modify("apps/backend/Dockerfile", 1)] })).toBe(false);
    expect(isServerTrivial({ files: [modify(".env.example", 1)] })).toBe(false);
  });

  it("touching a generated/dist file is NEVER trivial", () => {
    expect(isServerTrivial({ files: [modify("apps/backend/dist/index.js", 1)] })).toBe(false);
  });

  it("a money / auth / secrets path is NEVER trivial, however small the edit", () => {
    for (const p of [
      "apps/backend/src/services/billing/charge.ts",
      "apps/backend/src/services/payments/capture.ts",
      "apps/backend/src/lib/stripe-client.ts",
      "apps/backend/src/services/payout-scheduler.ts",
      "apps/web/src/app/checkout/page.tsx",
      "apps/backend/src/middleware/auth.ts",
      "apps/backend/src/lib/session.ts",
      "apps/web/src/app/login/page.tsx",
      "apps/backend/src/services/oauth/exchange.ts",
      "apps/backend/src/lib/jwt.ts",
      "apps/backend/src/services/secret-store.ts",
      "apps/backend/src/routes/webhook-handler.ts",
    ]) {
      expect(isServerTrivial({ files: [modify(p, 1)] }), p).toBe(false);
    }
  });

  it("does NOT over-match an ordinary path that merely contains a substring", () => {
    for (const p of [
      "apps/web/src/components/AuthoredByCard.tsx",
      "apps/backend/src/lib/tokenizer-util.ts",
      "docs/authors.md",
    ]) {
      expect(isServerTrivial({ files: [modify(p, 2)] }), p).toBe(true);
    }
  });

  it("a diff over the changed-line cap is NEVER trivial", () => {
    expect(
      isServerTrivial({ files: [modify("apps/web/src/Big.tsx", TRIVIAL_MAX_CHANGED_LINES + 1)] }),
    ).toBe(false);
  });

  it("a diff exactly at the cap with only safe files stays trivial", () => {
    expect(
      isServerTrivial({ files: [modify("apps/web/src/Ok.tsx", TRIVIAL_MAX_CHANGED_LINES)] }),
    ).toBe(true);
  });

  it("counts changed lines across ALL files against the cap", () => {
    expect(
      isServerTrivial({
        files: [modify("a.md", 15), modify("b.css", 10)],
      }),
    ).toBe(false);
  });
});

describe("trivial-guard — effectiveRiskClass", () => {
  it("downgrades a bogus trivial (route change) to low", () => {
    expect(
      effectiveRiskClass("trivial", {
        files: [modify("apps/backend/src/routes/pay.ts", 2)],
        httpRouteChanged: true,
      }),
    ).toBe("low");
  });

  it("downgrades a bogus trivial (big code diff) to low", () => {
    expect(
      effectiveRiskClass("trivial", { files: [modify("apps/backend/src/svc.ts", 50)] }),
    ).toBe("low");
  });

  it("keeps a genuine trivial change trivial", () => {
    expect(effectiveRiskClass("trivial", { files: [modify("docs/x.md", 2)] })).toBe("trivial");
  });

  it("never touches low / medium", () => {
    expect(effectiveRiskClass("low", { files: [modify("docs/x.md", 2)] })).toBe("low");
    expect(effectiveRiskClass("medium", { files: [modify("docs/x.md", 2)] })).toBe("medium");
  });

  it("an unknown/absent value resolves to low (fail-safe: run the gates)", () => {
    expect(effectiveRiskClass(undefined, { files: [] })).toBe("low");
    expect(effectiveRiskClass("weird", { files: [] })).toBe("low");
  });
});
