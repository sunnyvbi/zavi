
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveRunAgentGlobalConcurrency,
  RUN_AGENT_CONCURRENCY_DEFAULT,
} from "../run-agent-concurrency";

const BACKEND_ROOT = join(__dirname, "..", "..", "..");

describe("run-agent global concurrency resolver (memcg OOM bound)", () => {
  it("defaults to 8 when RUN_AGENT_CONCURRENCY is unset (4 GB host)", () => {
    expect(RUN_AGENT_CONCURRENCY_DEFAULT).toBe(8);
    expect(resolveRunAgentGlobalConcurrency(undefined)).toBe(8);
  });

  it("parses a valid positive integer from the env string", () => {
    expect(resolveRunAgentGlobalConcurrency("4")).toBe(4);
    expect(resolveRunAgentGlobalConcurrency("6")).toBe(6);
    expect(resolveRunAgentGlobalConcurrency("1")).toBe(1);
  });

  it("fail-safes to the default 8 on empty / non-numeric / whitespace", () => {
    expect(resolveRunAgentGlobalConcurrency("")).toBe(8);
    expect(resolveRunAgentGlobalConcurrency("abc")).toBe(8);
    expect(resolveRunAgentGlobalConcurrency("   ")).toBe(8);
  });

  it("fail-safes to the default 8 on zero / negative (never disables the queue)", () => {
    expect(resolveRunAgentGlobalConcurrency("0")).toBe(8);
    expect(resolveRunAgentGlobalConcurrency("-3")).toBe(8);
  });

  it("run-agent.ts wires the global ceiling to the resolver, not a hardcoded 50", () => {
    const src = readFileSync(join(BACKEND_ROOT, "workers", "functions", "run-agent.ts"), "utf8");
    expect(src).toMatch(
      /RUN_AGENT_GLOBAL_CONCURRENCY\s*=\s*resolveRunAgentGlobalConcurrency\(\)/,
    );
    expect(src).not.toMatch(/RUN_AGENT_GLOBAL_CONCURRENCY\s*=\s*50\b/);
  });
});

describe("deploy memory limit grep-guard (memcg OOM bound)", () => {
  const compose = readFileSync(
    join(BACKEND_ROOT, "docker", "main", "docker-compose.yml"),
    "utf8",
  );

  it("praxis-backend memory limit is raised to 3 GiB (3072m), not the old 1024m", () => {
    expect(compose).toMatch(/memory:\s*3072m/);
    expect(compose).not.toMatch(/memory:\s*1024m/);
  });

  it("sets a top-level mem_limit of 3g (the runtime-honored limit, 4 GB host)", () => {
    expect(compose).toMatch(/mem_limit:\s*3g/);
  });

  it("caps total memory+swap at 4g (1 GiB swap cushion)", () => {
    expect(compose).toMatch(/memswap_limit:\s*4g/);
  });

  it("does not pin RUN_AGENT_CONCURRENCY in compose, so the code default applies", () => {
    expect(compose).not.toMatch(/-\s*RUN_AGENT_CONCURRENCY=/);
  });
});
