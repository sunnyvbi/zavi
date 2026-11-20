
export const OPERATOR_DB_DOMAIN_AGENTS: ReadonlySet<string> = new Set<string>([
  "pm",
  "operator",
  "chief-of-staff",
  "dispute-response",
  "support-lead",
]);

export const TRUNCATED_SCOPE_DOMAIN_AGENTS: ReadonlySet<string> = new Set<string>([
  "performance-marketer",
  "growth-lead",
  "operator",
  "pm",
  "chief-of-staff",
  "support-lead",
  "dispute-response",
  "research",
]);

export const PAYMENT_DOMAIN_AGENTS: ReadonlySet<string> = new Set<string>([
  "support-lead",
  "dispute-response",
]);

export const STATUS_DOMAIN_AGENTS: ReadonlySet<string> = new Set<string>([
  "chief-of-staff",
  "pm",
  "support-lead",
  "advisor",
]);

export const SELF_CONTRADICTION_DOMAIN_AGENTS: ReadonlySet<string> = new Set<string>([
  "chief-of-staff",
  "pm",
  "operator",
  "growth-lead",
  "performance-marketer",
  "support-lead",
  "research",
]);
