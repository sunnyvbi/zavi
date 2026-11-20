import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEPLOY_YML = resolve(
  __dirname,
  "../../../../../.github/workflows/deploy.yml",
);
const LINT_YML = resolve(__dirname, "../../../../../.github/workflows/lint.yml");

function loadDeployYml(): string {
  return readFileSync(DEPLOY_YML, "utf8");
}

describe("deploy.yml compose pre-flight parse gate", () => {
  it("validates the compose file with `docker compose ... config -q` BEFORE any container is touched", () => {
    const src = loadDeployYml();
    const gateIdx = src.search(
      /docker compose -f "\.\/\$COMPOSE" config -q/,
    );
    expect(gateIdx).toBeGreaterThan(-1);

    const rollbackTagIdx = src.indexOf(
      "docker tag praxis-backend:latest praxis-backend:rollback",
    );
    const tempStartIdx = src.indexOf("--name praxis-backend-new");
    const swapStopIdx = src.search(/docker stop -t \d+ praxis-backend/);
    expect(rollbackTagIdx).toBeGreaterThan(-1);
    expect(tempStartIdx).toBeGreaterThan(-1);
    expect(swapStopIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(rollbackTagIdx);
    expect(gateIdx).toBeLessThan(tempStartIdx);
    expect(gateIdx).toBeLessThan(swapStopIdx);
  });

  it("a failed parse gate writes the FAIL sentinel and aborts (failed deploy, not an outage)", () => {
    const src = loadDeployYml();
    expect(src).toMatch(
      /FAIL: compose file unparseable — aborting BEFORE touching the running container/,
    );
  });
});

describe("deploy.yml snapshotted rollback compose", () => {
  it("snapshots the serving compose BEFORE the checkout moves to the new SHA", () => {
    const src = loadDeployYml();
    const snapshotIdx = src.indexOf('docker compose -f "$SNAP" config > "$ROLLBACK_COMPOSE"');
    const fetchIdx = src.indexOf("git fetch origin");
    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(snapshotIdx).toBeLessThan(fetchIdx);
  });

  it("the C5 rollback path brings the old container back with the SNAPSHOT, not the new checkout's compose", () => {
    const src = loadDeployYml();
    const rollbackBlockIdx = src.indexOf("ROLLING BACK");
    expect(rollbackBlockIdx).toBeGreaterThan(-1);
    const afterRollback = src.slice(rollbackBlockIdx);
    expect(afterRollback).toMatch(/-f "\$ROLLBACK_COMPOSE"/);
    const snapshotUseIdx = afterRollback.indexOf('-f "$ROLLBACK_COMPOSE"');
    const checkoutUseIdx = afterRollback.indexOf(
      '-f "./$COMPOSE"',
    );
    expect(snapshotUseIdx).toBeGreaterThan(-1);
    expect(checkoutUseIdx).toBeGreaterThan(-1);
    expect(snapshotUseIdx).toBeLessThan(checkoutUseIdx);
  });

  it("never overwrites the snapshot with an unparseable compose (a prior failed deploy leaves the checkout on its broken SHA)", () => {
    const src = loadDeployYml();
    const snapshotIdx = src.indexOf('docker compose -f "$SNAP" config > "$ROLLBACK_COMPOSE"');
    expect(snapshotIdx).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, snapshotIdx - 400), snapshotIdx);
    expect(before).toMatch(/config -q/);
  });
});

describe("lint.yml compose CI parse gate", () => {
  it("PR-gating CI runs `docker compose config -q` on the prod compose file so a broken file can never merge", () => {
    const src = readFileSync(LINT_YML, "utf8");
    expect(src).toMatch(/static-gates:/);
    expect(src).toMatch(/docker compose file must parse/);
    expect(src).toMatch(/for f in main api worker; do/);
    expect(src).toMatch(
      /docker compose -f "apps\/backend\/docker\/\$f\/docker-compose\.yml" config -q/,
    );
  });
});
