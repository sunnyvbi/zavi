
import { decideTenantOwnership } from "@/services/governance/tenant-ownership";
import { decideOperatorTool } from "../operator-policy";
import { creditsEnforcedFromBlob } from "../credits";
import {
  countersFromSeed,
  type GovernanceGolden,
} from "./goldens";

export type ScoredGovernanceCase = {
  name: string;
  kind: GovernanceGolden["kind"];
  incident?: string;
  pass: boolean;
  reason?: string;
};

export type GovernanceScoreReport = {
  total: number;
  passed: number;
  accuracy: number;
  cases: ScoredGovernanceCase[];
  incidentFailures: ScoredGovernanceCase[];
};

function scoreOne(g: GovernanceGolden): string | null {
  switch (g.kind) {
    case "tenant_ownership": {
      const got = decideTenantOwnership(g.input);
      if (got.allow !== g.expect.allow) {
        return `expected allow=${g.expect.allow}, got allow=${got.allow}`;
      }
      if (got.reason !== g.expect.reason) {
        return `expected reason=${g.expect.reason}, got reason=${got.reason}`;
      }
      return null;
    }
    case "operator_tool": {
      const { counters_seed, ...rest } = g.input;
      const got = decideOperatorTool({
        ...rest,
        counters: countersFromSeed(counters_seed),
      });
      if (got.allow !== g.expect.allow) {
        return `expected allow=${g.expect.allow}, got allow=${got.allow} (reason=${got.reason})`;
      }
      if (got.reason !== g.expect.reason) {
        return `expected reason=${g.expect.reason}, got reason=${got.reason}`;
      }
      return null;
    }
    case "credits_enforced": {
      const got = creditsEnforcedFromBlob(g.input.blob, g.input.tenantId);
      if (got !== g.expect.enforced) {
        return `expected enforced=${g.expect.enforced}, got ${got}`;
      }
      return null;
    }
    default: {
      const _never: never = g;
      return `unknown golden kind: ${JSON.stringify(_never)}`;
    }
  }
}

export function scoreGovernance(
  goldens: GovernanceGolden[],
): GovernanceScoreReport {
  const cases: ScoredGovernanceCase[] = goldens.map((g) => {
    const reason = scoreOne(g);
    return {
      name: g.name,
      kind: g.kind,
      incident: g.incident,
      pass: reason === null,
      reason: reason ?? undefined,
    };
  });
  const passed = cases.filter((c) => c.pass).length;
  return {
    total: cases.length,
    passed,
    accuracy: cases.length ? passed / cases.length : 0,
    cases,
    incidentFailures: cases.filter((c) => c.incident && !c.pass),
  };
}
