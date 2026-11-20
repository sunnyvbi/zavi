
export const AGENT_ROLEFIT_MODEL: Record<string, string> = {
  engineer: "gpt-5.3-codex",
  qa: "gpt-5.3-codex",

  pm: "gpt-5.5-pro",
  research: "gpt-5.5-pro",
  "growth-lead": "gpt-5.5-pro",
  advisor: "gpt-5.5-pro",
  "chief-of-staff": "gpt-5.5-pro",
  "company-founder": "gpt-5.5-pro",

  "support-lead": "gpt-5.5",
  "dispute-response": "gpt-5.5",
  social: "gpt-5.5",
  "performance-marketer": "gpt-5.5",
  "content-design": "gpt-5.5",
  "outbound-sdr": "gpt-5.5",
  "browser-operator": "gpt-5.5",
};

export const DEFAULT_ROLEFIT_MODEL = "gpt-5.5";

export function rolefitModel(slug: string): string {
  return AGENT_ROLEFIT_MODEL[slug] ?? DEFAULT_ROLEFIT_MODEL;
}
