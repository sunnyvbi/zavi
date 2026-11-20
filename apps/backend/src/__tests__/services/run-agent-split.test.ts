import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveBackgroundReserve,
  resolveRunAgentGlobalConcurrency,
  RUN_AGENT_BACKGROUND_RESERVE_DEFAULT,
} from "../../../workers/functions/run-agent-concurrency";

describe("resolveBackgroundReserve (interactive floor)", () => {
  it("defaults to 2 when unset/NaN/negative", () => {
    expect(resolveBackgroundReserve(undefined, 8)).toBe(2);
    expect(resolveBackgroundReserve("abc", 8)).toBe(2);
    expect(resolveBackgroundReserve("-3", 8)).toBe(2);
    expect(RUN_AGENT_BACKGROUND_RESERVE_DEFAULT).toBe(2);
  });
  it("honors a valid env value", () => {
    expect(resolveBackgroundReserve("3", 8)).toBe(3);
    expect(resolveBackgroundReserve("0", 8)).toBe(0);
  });
  it("CLAMPS so background always keeps >=1 slot (reserve < globalLimit)", () => {
    expect(resolveBackgroundReserve("8", 8)).toBe(7);
    expect(resolveBackgroundReserve("99", 8)).toBe(7);
    expect(resolveBackgroundReserve("2", 2)).toBe(1);
    expect(resolveBackgroundReserve("5", 1)).toBe(0);
  });
  it("the derived limits keep total <= G and a real reserve at the prod default", () => {
    const G = resolveRunAgentGlobalConcurrency(undefined);
    const reserve = resolveBackgroundReserve(undefined, G);
    const bgLimit = G - reserve;
    expect(G).toBe(8);
    expect(bgLimit).toBe(6);
    expect(bgLimit).toBeGreaterThanOrEqual(1);
    expect(bgLimit).toBeLessThan(G);
  });

  it("boot invariant (1 <= bgLimit <= G) holds for EVERY legal G — incl. the G=1 ops-throttle edge", () => {
    for (const G of [1, 2, 3, 4, 8, 16, 50]) {
      const reserve = resolveBackgroundReserve(undefined, G);
      const bgLimit = G - reserve;
      expect(bgLimit, `G=${G}: bgLimit=${bgLimit} must be >=1`).toBeGreaterThanOrEqual(1);
      expect(bgLimit, `G=${G}: bgLimit=${bgLimit} must be <=G`).toBeLessThanOrEqual(G);
    }
    expect(resolveBackgroundReserve(undefined, 1)).toBe(0);
  });
});

describe("run-agent.ts split config (source-guard)", () => {
  const src = readFileSync(
    resolve(__dirname, "../../../workers/functions/run-agent.ts"),
    "utf8",
  );
  it("defines two functions via one factory: background keeps id run-agent, interactive is new", () => {
    expect(src).toMatch(/function makeRunAgentFn\(/);
    expect(src).toMatch(/id:\s*"run-agent"/);
    expect(src).toMatch(/id:\s*"run-agent-interactive"/);
    expect(src).toMatch(/export const runAgentFn = makeRunAgentFn/);
    expect(src).toMatch(/export const runAgentInteractiveFn = makeRunAgentFn/);
  });
  it("routes by mutually-exclusive lane trigger; background also catches legacy", () => {
    expect(src).toContain(`"event.data.lane == 'interactive'"`);
    expect(src).toContain(`"event.data.lane != 'interactive'"`);
  });
  it("global concurrency is ACCOUNT-scope (shared queue, no memory doubling)", () => {
    expect(src).toMatch(/scope:\s*"account"[\s\S]{0,80}"run-agent-global"/);
    expect(src).toMatch(/scope:\s*"fn"[\s\S]{0,80}event\.data\.tenant_id/);
  });
  it("interactive gets G, background gets G-reserve, with a boot invariant assert", () => {
    expect(src).toMatch(/globalLimit:\s*RUN_AGENT_GLOBAL_CONCURRENCY,/);
    expect(src).toMatch(/RUN_AGENT_GLOBAL_CONCURRENCY - RUN_AGENT_BACKGROUND_RESERVE/);
    expect(src).toMatch(/invalid concurrency/);
  });
  it("step ids inside the handler are byte-stable (unchanged by the split)", () => {
    for (const id of ['step.run("claim"', 'step.run("dispatch"', 'step.run("persist-failure"']) {
      expect(src).toContain(id);
    }
  });
});
