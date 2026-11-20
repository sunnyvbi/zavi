
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const shell = readFileSync(join(__dirname, "WorkspaceShell.tsx"), "utf8");
const websiteTab = readFileSync(join(__dirname, "WebsiteTab.tsx"), "utf8");

function settingsOpen(source: string): string {
  const at = source.indexOf('kind: "settings"');
  expect(at).toBeGreaterThan(-1);
  const from = source.lastIndexOf("openTab(", at);
  expect(from).toBeGreaterThan(-1);
  return source.slice(from, source.indexOf(";", at));
}

describe("openTab", () => {
  it("accepts a push option and hands it to every activate path", () => {
    expect(shell).toContain("opts?: { push?: boolean },");
    expect(shell).toContain("activateTab(next, { push: opts?.push });");
    expect(shell).toContain("{ push: opts?.push },");
  });

  it("still replaces by default, so an ordinary tab switch adds no history", () => {
    const sig = shell.slice(
      shell.indexOf("const openTab = useCallback("),
      shell.indexOf("): string => {", shell.indexOf("const openTab = useCallback(")),
    );
    expect(sig).toContain("opts?: { push?: boolean }");
    expect(sig).not.toContain("push = true");
  });
});

describe("the trips away from a build", () => {
  it("pushes when the app header opens Settings", () => {
    expect(settingsOpen(websiteTab)).toContain("{ push: true }");
  });

  it("keeps the build id and view in the url it is leaving behind", () => {
    const routes = readFileSync(
      join(__dirname, "navigation", "workspaceRoutes.ts"),
      "utf8",
    );
    expect(routes).toContain('params.set("tab", "build")');
    expect(routes).toContain('params.set("build", tab.payload.sessionId)');
  });
});
