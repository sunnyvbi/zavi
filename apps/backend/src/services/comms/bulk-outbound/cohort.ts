
export type OutboundBasis = "opt_in" | "relationship";

export const BULK_COHORT_HARD_CAP = 1000;

export const COHORT_SAMPLE_SIZE = 5;

export type CohortSelector = {
  segment: string;
  filters?: Record<string, string | number | boolean>;
};

export type CohortRecord = {
  email: string;
  opt_in_marketing?: boolean;
  has_relationship?: boolean;
};

export interface CohortSource {
  fetchCandidates(
    tenant_id: string,
    selector: CohortSelector,
  ): Promise<CohortRecord[]>;
}

export type ResolvedCohort = {
  recipients: string[];
  est_recipient_count: number;
  sample_recipients: string[];
  basis: OutboundBasis;
  capped: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  if (!e || e.length > 320 || !EMAIL_RE.test(e)) return null;
  return e;
}

function isEligible(rec: CohortRecord, basis: OutboundBasis): boolean {
  if (basis === "opt_in") return rec.opt_in_marketing === true;
  return rec.has_relationship === true;
}

export async function resolveCohort(
  tenant_id: string,
  selector: CohortSelector,
  basis: OutboundBasis,
  source: CohortSource,
): Promise<ResolvedCohort> {
  const candidates = await source.fetchCandidates(tenant_id, selector);

  const seen = new Set<string>();
  const eligible: string[] = [];
  for (const rec of candidates) {
    if (!isEligible(rec, basis)) continue;
    const email = normalizeEmail(rec.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    eligible.push(email);
  }

  const capped = eligible.length > BULK_COHORT_HARD_CAP;
  const recipients = capped ? eligible.slice(0, BULK_COHORT_HARD_CAP) : eligible;

  return {
    recipients,
    est_recipient_count: recipients.length,
    sample_recipients: recipients.slice(0, COHORT_SAMPLE_SIZE),
    basis,
    capped,
  };
}

export function coerceBasis(raw: unknown): OutboundBasis {
  return raw === "relationship" ? "relationship" : "opt_in";
}
