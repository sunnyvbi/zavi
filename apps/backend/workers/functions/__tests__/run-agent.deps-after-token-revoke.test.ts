import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "..", "run-agent.ts"), "utf8");

const stepAt = (name: string) => {
  const i = src.indexOf(`step.run("${name}"`);
  expect(i, `step ${name} not found`).toBeGreaterThan(-1);
  expect(src.indexOf(`step.run("${name}"`, i + 1), `step ${name} appears twice`).toBe(-1);
  return i;
};

describe("tenant code never runs while the umbrella GitHub token is in the sandbox", () => {
  const inject = stepAt("inject-secrets");
  const revoke = stepAt("revoke-sandbox-github-token");
  const engineerGate = src.lastIndexOf('if (sandbox && claim.agent_slug === "engineer" && !sitePrepared) {', revoke);
  const gateEnd = src.indexOf("\n      }\n", revoke);

  it("the revoke step sits in the engineer-only block", () => {
    expect(inject).toBeLessThan(revoke);
    expect(engineerGate).toBeGreaterThan(inject);
    expect(gateEnd).toBeGreaterThan(revoke);
  });

  for (const step of ["first-build-preview-install", "provisioned-build-deps", "kick-live-edit-preview"]) {
    it(`${step} runs after the token is revoked, inside the same engineer block`, () => {
      const at = stepAt(step);
      expect(at).toBeGreaterThan(revoke);
      expect(at).toBeLessThan(gateEnd);
    });
  }

  it("the draft checkout still runs while the token is present, since it fetches from GitHub", () => {
    const checkout = stepAt("checkout-live-edit-draft");
    expect(checkout).toBeGreaterThan(inject);
    expect(checkout).toBeLessThan(revoke);
  });
});

describe("the merged site prep step revokes the token before tenant code runs", () => {
  const prep = stepAt("prepare-site-sandbox");
  const body = src.slice(prep, src.indexOf("\n          );", prep));

  it("runs secrets, clone, revoke, then the preview (the site's own code) and deps, in that order", () => {
    const order = ["injectSecrets()", "bootstrapRepo()", "await revokeToken();", "siteSandboxReady(", "provisionedBuildDeps()"].map((k) => body.indexOf(k));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("is never used for a live edit (its draft checkout needs the token) or a first-build scaffold", () => {
    const guard = src.slice(src.lastIndexOf("sitePrepared =", prep), prep);
    expect(guard).toContain("!isLiveEditPayload(claim.payload)");
    expect(guard).toContain("!isFirstBuildScaffold(claim.payload)");
    expect(guard).toContain('claim.agent_slug === "engineer"');
  });
});
