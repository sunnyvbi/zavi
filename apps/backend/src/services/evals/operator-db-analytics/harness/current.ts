
import type { OperatorDbType } from "@/services/tools/operator-db/types";

export type EvalTenant = {
  tenant_id: string;
  dialect: "postgres" | "mysql" | "mongodb";
  shape: string;
  connectionString: string;
  catalogRow: {
    dialect: OperatorDbType;
    catalog: unknown;
    hints: unknown;
    catalog_hash: string;
    coverage: unknown;
    discovery_error: null;
    updated_at: string;
  };
};

export const EVAL_TENANT_ID = "00000000-0000-4000-8000-00000000e7a1";

let current: EvalTenant | null = null;

export function setCurrentTenant(t: EvalTenant): void {
  current = t;
}

export function currentTenant(): EvalTenant {
  if (!current) throw new Error("no eval tenant installed — call installEvalTenant() first");
  return current;
}
