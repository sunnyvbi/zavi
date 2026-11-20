import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_SETTINGS, CONSENT_KEYS_PER_TENANT_ONLY } from "@/services/settings/registry";
import {
  BUILD_REPLAY_FIXTURES,
  BUILD_REPLAY_OFF,
  BUILD_REPLAY_SETTING,
  buildReplayAllowed,
} from "../build-replay-config";

const backendRoot = join(__dirname, "../../../..");
const dockerfile = readFileSync(join(backendRoot, "docker/main/Dockerfile"), "utf-8");
const compose = readFileSync(join(backendRoot, "docker/main/docker-compose.yml"), "utf-8");
const runtimeStage = dockerfile.slice(dockerfile.indexOf("AS runtime"));
const genericSrc = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf-8");

describe("saved builds never ship in the production image", () => {
  it("the runtime stage exists and copies no dev-fixtures directory", () => {
    expect(runtimeStage.length).toBeGreaterThan(0);
    expect(runtimeStage).not.toMatch(/dev-fixtures/);
    expect(runtimeStage).not.toMatch(/COPY\s+--from=build\s+\/app\/apps\/backend\s+/);
    expect(runtimeStage).not.toMatch(/COPY\s+apps\/backend\s/);
  });

  it("the runtime image sets NODE_ENV=production, which the replay guard relies on", () => {
    expect(runtimeStage).toMatch(/^ENV NODE_ENV=production$/m);
    expect(buildReplayAllowed({ NODE_ENV: "production" })).toBe(false);
  });

  it("every backend service in compose runs with NODE_ENV=production", () => {
    expect(compose.match(/NODE_ENV=production/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(compose).not.toMatch(/NODE_ENV=(development|test)/);
  });
});

describe("build_replay_fixture registry entry", () => {
  const def = APP_SETTINGS[BUILD_REPLAY_SETTING];

  it("defaults off, is per tenant, and is per-tenant-only so no global row reaches a tenant", () => {
    expect(def.defaultValue).toBe(BUILD_REPLAY_OFF);
    expect(def.scope).toBe("per-tenant");
    expect(def.type).toBe("string");
    expect(CONSENT_KEYS_PER_TENANT_ONLY.has(BUILD_REPLAY_SETTING)).toBe(true);
  });

  it("offers exactly off plus the known fixtures", () => {
    expect(def.options).toEqual([BUILD_REPLAY_OFF, ...BUILD_REPLAY_FIXTURES]);
  });
});

describe("the replay seam sits in front of every model call", () => {
  it("runGeneric tries the replay before any other work", () => {
    const body = genericSrc.slice(genericSrc.indexOf("export async function runGeneric("));
    const firstStatements = body.slice(body.indexOf("{") + 1, body.indexOf("if (ctx.draft_mode === true"));
    expect(firstStatements).toMatch(/const replayed = await replayBuildStage\(ctx, payload\);\s*if \(replayed\) return replayed;/);
  });
});
