
import type { MorningBriefResponse } from "./morning-brief-assembler";
import { rewriteBrandLeak } from "../agents/brand-rewrite";

export type BriefViolationCode =
  | "residual_praxis"
  | "qa_test_string"
  | "null_name_token"
  | "lone_question_metric"
  | "internal_marker";

const QA_TEST_RE = /qa\s*test\s*/gi;
const RESIDUAL_PRAXIS_RE = /\bPraxis\b/g;
const NULL_NAME_TOKEN_RE = /^there$/i;
const LONE_QUESTION_RE = /^\??\s*\/?\s*\??$|^\?$/;
const INTERNAL_MARKER_RE =
  /\s*\[(observed|proposed|inferred|refine|smoke|test|qa|internal|draft)\]/gi;
const EM_DASH_SPACED_RE = /\s+[—–]\s+/g;
const EM_DASH_BARE_RE = /[—–]/g;

function scrubText(input: string): { text: string; violations: BriefViolationCode[] } {
  const violations: BriefViolationCode[] = [];

  let text = rewriteBrandLeak(input).text;
  const afterPraxis = text.replace(RESIDUAL_PRAXIS_RE, "Zavi");
  if (afterPraxis !== text) {
    violations.push("residual_praxis");
    text = afterPraxis;
  }

  const afterQa = text.replace(QA_TEST_RE, "").replace(/\s{2,}/g, " ").trim();
  if (afterQa !== text) {
    violations.push("qa_test_string");
    text = afterQa;
  }

  const afterMarker = text
    .replace(INTERNAL_MARKER_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (afterMarker !== text) {
    violations.push("internal_marker");
    text = afterMarker;
  }

  text = text.replace(EM_DASH_SPACED_RE, ", ").replace(EM_DASH_BARE_RE, "-");

  if (NULL_NAME_TOKEN_RE.test(text.trim())) {
    violations.push("null_name_token");
    text = "";
  }

  if (LONE_QUESTION_RE.test(text.trim())) {
    violations.push("lone_question_metric");
    text = "";
  }

  return { text, violations };
}

export function sanitizeBriefForCustomer(brief: MorningBriefResponse): {
  brief: MorningBriefResponse;
  violations: BriefViolationCode[];
} {
  const violations: BriefViolationCode[] = [];

  const goals = brief.goals.map((g) => {
    const obj = scrubText(g.objective);
    const tgt = scrubText(g.target_metric);
    violations.push(...obj.violations, ...tgt.violations);
    if (g.current_value == null || g.target_value == null) {
      violations.push("lone_question_metric");
    }
    return { ...g, objective: obj.text, target_metric: tgt.text };
  });

  const recent_activity = brief.recent_activity.map((a) => {
    const lab = scrubText(a.label);
    violations.push(...lab.violations);
    return { ...a, label: lab.text };
  });

  const top_decisions = brief.top_decisions?.map((d) => {
    const title = scrubText(d.title);
    violations.push(...title.violations);
    const out: typeof d = { ...d, title: title.text };
    if (d.recommendation) {
      const r = scrubText(d.recommendation);
      violations.push(...r.violations);
      out.recommendation = r.text;
    }
    if (d.impact) {
      const i = scrubText(d.impact);
      violations.push(...i.violations);
      out.impact = i.text;
    }
    if (d.risk) {
      const rk = scrubText(d.risk);
      violations.push(...rk.violations);
      out.risk = rk.text;
    }
    return out;
  });

  const standup_atoms = (brief.standup_atoms ?? []).map((a) => {
    const t = scrubText(a.title);
    violations.push(...t.violations);
    return { ...a, title: t.text };
  });

  const hadGrowthLine = brief.growth_do_this_first != null;
  let growth_do_this_first: string | null = null;
  if (hadGrowthLine) {
    const g = scrubText(brief.growth_do_this_first as string);
    violations.push(...g.violations);
    growth_do_this_first = g.text.trim() ? g.text : null;
  }

  const scrubbed: MorningBriefResponse = {
    ...brief,
    goals,
    recent_activity,
    standup_atoms,
    ...(top_decisions ? { top_decisions } : {}),
    ...(hadGrowthLine ? { growth_do_this_first } : {}),
  };

  const uniqueViolations = [...new Set(violations)];

  return { brief: scrubbed, violations: uniqueViolations };
}

export function assertRenderedClean(parts: {
  subject: string;
  html: string;
  text: string;
}): BriefViolationCode[] {
  const violations = new Set<BriefViolationCode>();
  const blob = `${parts.subject}\n${parts.html}\n${parts.text}`;
  RESIDUAL_PRAXIS_RE.lastIndex = 0;
  QA_TEST_RE.lastIndex = 0;
  INTERNAL_MARKER_RE.lastIndex = 0;
  if (RESIDUAL_PRAXIS_RE.test(blob)) violations.add("residual_praxis");
  if (QA_TEST_RE.test(blob)) violations.add("qa_test_string");
  if (INTERNAL_MARKER_RE.test(blob)) violations.add("internal_marker");
  if (/\bgood morning there\b/i.test(blob)) violations.add("null_name_token");
  return [...violations];
}
