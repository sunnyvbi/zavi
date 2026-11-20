import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const route = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("/pages/[id] gate", () => {
  it("still sends a signed-out visitor to login, carrying the page it wanted", () => {
    expect(route).toMatch(/if \(!userData\?\.user\)/);
    expect(route).toMatch(/redirect\(`\/login\?next=\$\{encodeURIComponent\(`\/pages\/\$\{params\.id\}`\)\}`\)/);
  });

  it("never bounces a signed-in viewer to onboarding, which renders the workspace where the page should be", () => {
    expect(
      route,
      "/start inside the artifact iframe is what the founder sees instead of their page",
    ).not.toMatch(/redirect\("\/start"\)/);
  });

  it("does not gate on the tenant-name helper, whose null means \"session still hydrating\"", () => {
    expect(route).not.toMatch(/fetchActiveTenant/);
  });

  it("leaves tenant scoping to the backend, which is the only authority on it", () => {
    const viewer = readFileSync(
      join(__dirname, "../../../components/workspace/SharedPageViewer.tsx"),
      "utf8",
    );
    expect(viewer).toMatch(/res\.status === 404/);
    expect(viewer).toMatch(/belongs to a different workspace/);
  });

  it("keeps the helper's own warning intact, so nobody re-adds the gate", () => {
    const resolver = readFileSync(
      join(__dirname, "../../../lib/session-tenant-client.ts"),
      "utf8",
    );
    expect(resolver).toMatch(/session still hydrating — caller must not cache this/);
    expect(resolver).toMatch(/None of these is an authorization/);
  });
});
