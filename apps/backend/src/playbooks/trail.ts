
export type TrailDecisionRow = {
  decision_class: string;
  status: string | null;
  dispatch_error: string | null;
};

export type TrailSummary = {
  total: number;
  acted: number;
  proposed: number;
  approved: number;
  rejected: number;
  blocked: number;
};

export function summarizeTrail(rows: readonly TrailDecisionRow[]): TrailSummary {
  const s: TrailSummary = { total: 0, acted: 0, proposed: 0, approved: 0, rejected: 0, blocked: 0 };
  for (const r of rows) {
    s.total += 1;
    switch (r.status) {
      case "acted":
        s.acted += 1;
        break;
      case "proposed":
        s.proposed += 1;
        break;
      case "approved":
        s.approved += 1;
        break;
      case "rejected":
        s.rejected += 1;
        if (r.dispatch_error) s.blocked += 1;
        break;
      default:
        break;
    }
  }
  return s;
}
