
import type {
  OperatorPolicyInput,
  ToolCounters,
} from "../operator-policy";

export type TenantOwnershipCase = {
  kind: "tenant_ownership";
  name: string;
  incident?: "cross_tenant_reach";
  input: { callerTenantId: string; canonicalTenantId: string };
  expect: { allow: boolean; reason: "ok" | "tenant_mismatch" };
};

export type OperatorBudgetCase = {
  kind: "operator_tool";
  name: string;
  incident?: "budget_runaway" | "untrusted_inbound_exfil";
  input: Omit<OperatorPolicyInput, "counters"> & {
    counters_seed: Record<string, number>;
  };
  expect:
    | { allow: true; reason: "ok" }
    | { allow: false; reason: string };
};

export type CreditsEnforcedCase = {
  kind: "credits_enforced";
  name: string;
  incident?: never;
  input: {
    blob:
      | { credits_enforced?: boolean; credits_enforced_allowlist?: unknown }
      | null;
    tenantId: string;
  };
  expect: { enforced: boolean };
};

export type GovernanceGolden =
  | TenantOwnershipCase
  | OperatorBudgetCase
  | CreditsEnforcedCase;

const READ_CLASSIFY: OperatorPolicyInput["classify"] = {
  tier: "tier1",
  confidence: 0.9,
  evidence_needed: ["github", "memory"],
} as unknown as OperatorPolicyInput["classify"];

const TENANT_A = "73db45ff-457e-4541-bc8f-bdb625390204";
const TENANT_B = "e0fe9ea8-0000-0000-0000-000000000000";

const TENANT_OWNERSHIP: TenantOwnershipCase[] = [
  {
    kind: "tenant_ownership",
    name: "same tenant → allow (run acts for its owner)",
    input: { callerTenantId: TENANT_A, canonicalTenantId: TENANT_A },
    expect: { allow: true, reason: "ok" },
  },
  {
    kind: "tenant_ownership",
    name: "different tenant → REFUSE (cross-tenant reach)",
    incident: "cross_tenant_reach",
    input: { callerTenantId: TENANT_A, canonicalTenantId: TENANT_B },
    expect: { allow: false, reason: "tenant_mismatch" },
  },
  {
    kind: "tenant_ownership",
    name: "caller claims owner but run belongs to another → REFUSE",
    incident: "cross_tenant_reach",
    input: { callerTenantId: TENANT_B, canonicalTenantId: TENANT_A },
    expect: { allow: false, reason: "tenant_mismatch" },
  },
  {
    kind: "tenant_ownership",
    name: "blank canonical tenant → REFUSE (fail-closed)",
    input: { callerTenantId: TENANT_A, canonicalTenantId: "" },
    expect: { allow: false, reason: "tenant_mismatch" },
  },
];

const OPERATOR_BUDGET: OperatorBudgetCase[] = [
  {
    kind: "operator_tool",
    name: "github__search_code at cap (12/12) → DENY (budget hard-stop)",
    incident: "budget_runaway",
    input: {
      classify: READ_CLASSIFY,
      tool_name: "github__search_code",
      run_id: "run-eval-budget-1",
      iter: 2,
      counters_seed: { github__search_code: 12 },
    },
    expect: { allow: false, reason: "github_search_code_budget_exhausted" },
  },
  {
    kind: "operator_tool",
    name: "github__search_code over cap (13/12) → DENY",
    incident: "budget_runaway",
    input: {
      classify: READ_CLASSIFY,
      tool_name: "github__search_code",
      run_id: "run-eval-budget-2",
      iter: 2,
      counters_seed: { github__search_code: 13 },
    },
    expect: { allow: false, reason: "github_search_code_budget_exhausted" },
  },
  {
    kind: "operator_tool",
    name: "memory__write at cap (10/10) → DENY (corpus-pollution hard-stop)",
    incident: "budget_runaway",
    input: {
      classify: READ_CLASSIFY,
      tool_name: "memory__write",
      run_id: "run-eval-budget-3",
      iter: 2,
      counters_seed: { memory__write: 10 },
    },
    expect: { allow: false, reason: "github_search_code_budget_exhausted" },
  },
  {
    kind: "operator_tool",
    name: "github__search_code under cap (4/12) → ALLOW (budget remaining)",
    input: {
      classify: READ_CLASSIFY,
      tool_name: "github__search_code",
      run_id: "run-eval-budget-4",
      iter: 2,
      counters_seed: { github__search_code: 4 },
    },
    expect: { allow: true, reason: "ok" },
  },
  {
    kind: "operator_tool",
    name:
      "untrusted-inbound run reaching web_fetch → DENY (E9 exfil vector, PR #1675)",
    incident: "untrusted_inbound_exfil",
    input: {
      classify: READ_CLASSIFY,
      tool_name: "web_fetch__fetch",
      run_id: "run-eval-egress-1",
      iter: 2,
      untrusted_inbound: true,
      counters_seed: {},
    },
    expect: { allow: false, reason: "egress_denied_untrusted_inbound" },
  },
];

const CREDITS_ENFORCED: CreditsEnforcedCase[] = [
  {
    kind: "credits_enforced",
    name: "global flag ON → enforced for every tenant (hard-cap armed)",
    input: { blob: { credits_enforced: true }, tenantId: TENANT_A },
    expect: { enforced: true },
  },
  {
    kind: "credits_enforced",
    name: "tenant in canary allowlist → enforced (hard-cap armed)",
    input: {
      blob: { credits_enforced_allowlist: [TENANT_A] },
      tenantId: TENANT_A,
    },
    expect: { enforced: true },
  },
  {
    kind: "credits_enforced",
    name: "tenant NOT in allowlist + global OFF → not enforced",
    input: {
      blob: { credits_enforced: false, credits_enforced_allowlist: [TENANT_B] },
      tenantId: TENANT_A,
    },
    expect: { enforced: false },
  },
  {
    kind: "credits_enforced",
    name: "missing blob → not enforced (safe default, no accidental lockout)",
    input: { blob: null, tenantId: TENANT_A },
    expect: { enforced: false },
  },
];

export const GOVERNANCE_GOLDENS: GovernanceGolden[] = [
  ...TENANT_OWNERSHIP,
  ...OPERATOR_BUDGET,
  ...CREDITS_ENFORCED,
];

export function countersFromSeed(seed: Record<string, number>): ToolCounters {
  return new Map<string, number>(Object.entries(seed));
}
