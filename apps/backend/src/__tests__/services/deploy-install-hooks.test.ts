import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../../..");
const rootPkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"] as const;

function toolOf(script: string): string | null {
  const first = script.trim().split(/\s+/)[0];
  if (!first) return null;
  if (["node", "npm", "npx", "echo", "true", ":", "sh", "bash", "cd"].includes(first)) return null;
  if (first.includes("/") || first.startsWith(".")) return null;
  return first;
}

describe("install lifecycle hooks must survive a production install", () => {
  it("every tool an install hook runs is a production dependency", () => {
    const deps = rootPkg.dependencies ?? {};
    const devDeps = rootPkg.devDependencies ?? {};
    const offenders: string[] = [];

    for (const hook of INSTALL_HOOKS) {
      const script = rootPkg.scripts?.[hook];
      if (!script) continue;
      const tool = toolOf(script);
      if (!tool) continue;
      if (tool in deps) continue;
      offenders.push(
        `"${hook}": "${script}" runs \`${tool}\`, which is ` +
          (tool in devDeps
            ? "a devDependency — absent from the prod image, which installs --omit=dev"
            : "not a root dependency at all"),
      );
    }

    expect(
      offenders,
      `The prod Docker stage runs \`npm install --omit=dev\`, so an install hook whose ` +
        `tool is a devDependency fails the IMAGE BUILD with exit 127 and blocks every ` +
        `deploy. Move the tool into "dependencies" (or drop the hook):\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the prod image still installs without dev dependencies", () => {
    const dockerfile = readFileSync(
      resolve(ROOT, "apps/backend/docker/main/Dockerfile"),
      "utf8",
    );
    expect(
      dockerfile.includes("--omit=dev"),
      "apps/backend/docker/main/Dockerfile no longer installs with --omit=dev. " +
        "If that is intentional, this guard's premise is gone and it should be " +
        "revisited rather than left asserting a rule that no longer bites.",
    ).toBe(true);
  });
});
