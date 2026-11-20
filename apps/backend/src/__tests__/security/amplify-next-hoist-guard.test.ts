import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../../../..");
const lock = JSON.parse(readFileSync(resolve(repoRoot, "package-lock.json"), "utf8"));
const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const adminPkg = JSON.parse(
  readFileSync(resolve(repoRoot, "apps/admin/package.json"), "utf8"),
);
const webPkg = JSON.parse(readFileSync(resolve(repoRoot, "apps/web/package.json"), "utf8"));

describe("amplify next hoist guard", () => {
  it("keeps `next` as a root dependency so the hoisted install can never silently disappear", () => {
    expect(rootPkg.dependencies?.next).toBeDefined();
  });

  it("locks node_modules/next at the repo root — Amplify's compute requires it there at runtime", () => {
    const rootNext = lock.packages?.["node_modules/next"];
    expect(rootNext?.version).toBeDefined();
  });

  it("keeps the root copy on the exact version the apps build with", () => {
    const rootNext = lock.packages?.["node_modules/next"]?.version;
    expect(adminPkg.dependencies?.next).toBe(rootNext);
    expect(webPkg.dependencies?.next).toBe(rootNext);
  });

  it("ships the linux swc binary in the lock so Amplify's npm ci can build", () => {
    const hasLinuxSwc = Object.keys(lock.packages ?? {}).some((key) =>
      key.endsWith("@next/swc-linux-x64-gnu"),
    );
    expect(hasLinuxSwc).toBe(true);
  });
});
