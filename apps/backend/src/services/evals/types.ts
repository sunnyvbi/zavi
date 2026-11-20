
export type EvalCaseResult = {
  case_id: string;
  pass: boolean;
  reason: string | null;
  meta?: Record<string, unknown>;
};

export type EvalReport = {
  slug: string;
  ts: string;
  total: number;
  passed: number;
  failed: number;
  accuracy: number;
  failures: EvalCaseResult[];
  blocking_gate: boolean;
  notes?: string;
};
