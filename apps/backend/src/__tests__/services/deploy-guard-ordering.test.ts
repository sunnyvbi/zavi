import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEPLOY_YML = resolve(
  __dirname,
  "../../../../../.github/workflows/deploy.yml",
);

function loadDeployYml(): string {
  return readFileSync(DEPLOY_YML, "utf8");
}

describe("deploy.yml deploy-guard ordering", () => {
  it("the inflight-runs poll precedes the `docker rm -f praxis-backend` swap", () => {
    const src = loadDeployYml();
    const pollIdx = src.indexOf("/internal/inflight-runs");
    const swapIdx = src.search(/for c in praxis-backend /);
    expect(pollIdx).toBeGreaterThan(-1);
    expect(swapIdx).toBeGreaterThan(-1);
    expect(pollIdx).toBeLessThan(swapIdx);
  });

  it("the deploy-guard poll is BOUNDED (a finite cap, then ABORTS) — can never block a deploy forever, and never kills in-flight runs", () => {
    const src = loadDeployYml();
    expect(src).toMatch(/GUARD_MAX=\d+/);
    expect(src).toMatch(/while \[ "\$GUARD_I" -lt "\$GUARD_MAX" \]/);
    expect(src).toMatch(/cap.*reached.*ABORTING/i);
    expect(src).toMatch(/internal\/unquiesce/);
  });

  it("the outer completion poll outlives the guard cap — else the step times out mid-drain", () => {
    const src = loadDeployYml();
    const guardMax = Number(/GUARD_MAX=(\d+)/.exec(src)?.[1]);
    const pollCycles = Number(
      /Polling for deploy completion every 30s \(max \d+ min = (\d+) polls\)/.exec(
        src,
      )?.[1],
    );
    expect(Number.isFinite(guardMax)).toBe(true);
    expect(Number.isFinite(pollCycles)).toBe(true);

    const guardSeconds = guardMax * 2;
    const pollSeconds = pollCycles * 30;
    expect(pollSeconds - guardSeconds).toBeGreaterThanOrEqual(300);
  });

  it("the guard cap covers the p99 of real agent-run durations", () => {
    const src = loadDeployYml();
    const guardMax = Number(/GUARD_MAX=(\d+)/.exec(src)?.[1]);
    expect(guardMax * 2).toBeGreaterThanOrEqual(900);
  });

  it("the deploy-guard reads the OLD canonical container on CONTAINER_PORT (still serving), not the temp port", () => {
    const src = loadDeployYml();
    expect(src).toMatch(
      /127\.0\.0\.1:\$\{CONTAINER_PORT\}\/internal\/inflight-runs/,
    );
  });

  it("skip_inflight_guard is an opt-in dispatch input (default false) threaded to the on-box guard", () => {
    const src = loadDeployYml();
    expect(src).toMatch(
      /skip_inflight_guard:\n(?:\s+\w+:.*\n){0,3}?\s+default: false\n\s+type: boolean/,
    );
    expect(src).toMatch(/SKIP_INFLIGHT_GUARD='\$SKIP_INFLIGHT_GUARD'/);
    const skipIdx = src.indexOf('if [ "${SKIP_INFLIGHT_GUARD:-false}" = "true" ]');
    const swapIdx = src.search(/for c in praxis-backend /);
    expect(skipIdx).toBeGreaterThan(-1);
    expect(skipIdx).toBeLessThan(swapIdx);
    expect(src).toMatch(/if \[ "\$GUARD_SKIPPED" != "1" \] && \[ "\$GUARD_I" -ge "\$GUARD_MAX" \]/);
  });
});
