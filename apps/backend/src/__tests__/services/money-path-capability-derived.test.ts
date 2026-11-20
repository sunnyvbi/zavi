import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/agents/agent-capabilities", () => ({
  agentCapabilities: (slug: string) => ({
    money_path: slug === "new-money-agent",
    reads_operator_db: false,
    emits_artifact: false,
    structured_clarifications: false,
  }),
}));

import {
  isMoneyPathSlug,
  willBeInfraRetried,
  MONEY_PATH_SLUGS,
  type InfraRetryRow,
} from "@/services/agents/infra-retry";

function row(agent_slug: string): InfraRetryRow {
  return {
    id: "run-1",
    tenant_id: "t-1",
    agent_slug,
    status: "dispatch_error",
    error: null,
    infra_retry_count: 0,
    last_progress_at: null,
  };
}

describe("#6 money-path firewall is capability-derived (isMoneyPathSlug)", () => {
  it("keeps the hardcoded money agents classified money_path", () => {
    expect(isMoneyPathSlug("performance-marketer")).toBe(true);
    expect(isMoneyPathSlug("dispute-response")).toBe(true);
    expect(MONEY_PATH_SLUGS.has("performance-marketer")).toBe(true);
    expect(MONEY_PATH_SLUGS.has("dispute-response")).toBe(true);
  });

  it("classifies a capability-only money agent (NOT in the hardcoded set) as money-path", () => {
    expect(MONEY_PATH_SLUGS.has("new-money-agent")).toBe(false);
    expect(isMoneyPathSlug("new-money-agent")).toBe(true);
  });

  it("does NOT classify a read-only agent as money-path", () => {
    expect(isMoneyPathSlug("research")).toBe(false);
  });

  it("(a) EXCLUDES a capability-flagged money agent from blind infra auto-retry", () => {
    expect(willBeInfraRetried(row("new-money-agent"))).toBe(false);
  });

  it("(d) existing money members stay excluded; safe agents stay auto-retryable", () => {
    expect(willBeInfraRetried(row("performance-marketer"))).toBe(false);
    expect(willBeInfraRetried(row("dispute-response"))).toBe(false);
    expect(willBeInfraRetried(row("research"))).toBe(true);
  });

  it("(e) a custom agent (writes with no approval, no agent.md) is never infra-retried", () => {
    expect(willBeInfraRetried(row("c-abcdefghij"))).toBe(false);
  });
});
