import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../runner.ts"), "utf8");

describe("enqueueAgentRun — fail-fast tenant_id guard (DEL-686 #3)", () => {
  it("defines a MissingTenantId error with the clear message", () => {
    expect(SRC).toMatch(/export class MissingTenantId extends Error/);
    expect(SRC).toMatch(/enqueueAgentRun: tenant_id required/);
  });

  it("guards on blank/whitespace tenant_id and throws MissingTenantId", () => {
    expect(SRC).toMatch(
      /if \(!input\.tenant_id \|\| !input\.tenant_id\.trim\(\)\) \{\s*\n\s*throw new MissingTenantId\(\);/,
    );
  });

  it("runs the guard BEFORE the fleet-halt gate (i.e. first, before dedup/RPC)", () => {
    const guardIdx = SRC.indexOf("throw new MissingTenantId()");
    const fleetIdx = SRC.indexOf("if (await isFleetHalted())");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fleetIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fleetIdx);
  });
});
