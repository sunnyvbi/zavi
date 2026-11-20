import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const EMAIL_DIR = resolve(__dirname, "..");
const TEMPLATE_DIR = join(EMAIL_DIR, "templates");
const BACKEND_SRC = resolve(EMAIL_DIR, "..");

const source = (path: string) => readFileSync(path, "utf8");

const OWN_LAYOUT = new Set([
  "creator-invite.ts",
  "creator-invite-message.ts",
  "creator-simple-layout.ts",
]);

describe("system email template architecture", () => {
  it("routes every named email template through the shared Zavi shell", () => {
    const bypasses = readdirSync(TEMPLATE_DIR)
      .filter((name) => name.endsWith(".ts") && !OWN_LAYOUT.has(name))
      .filter(
        (name) => !source(join(TEMPLATE_DIR, name)).includes("renderEmail("),
      );

    expect(bypasses).toEqual([]);
  });

  it("routes customer notification renderers outside templates through the same shell", () => {
    const renderers = [
      join(EMAIL_DIR, "sendMaterialNewsDigest.ts"),
      join(BACKEND_SRC, "services/decisions/ad-budget-brake.ts"),
      join(BACKEND_SRC, "services/decisions/ad-budget-reconcile.ts"),
      join(BACKEND_SRC, "services/sites/idle.ts"),
      join(BACKEND_SRC, "services/analytics/anomaly-alert.ts"),
    ];
    const bypasses = renderers
      .filter((path) => !source(path).includes("renderEmail("))
      .map((path) => basename(path));

    expect(bypasses).toEqual([]);
  });
});
