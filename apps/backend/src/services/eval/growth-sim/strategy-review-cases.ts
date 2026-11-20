import type { ParsedStrategy } from "@/agents/cgo/strategy";
import type { ReviewToolEvidence } from "@/agents/cgo/plan-review";

const base: ParsedStrategy = {
  north_star: { metric: "new_customers", why: "Track new customers who complete a first paid session.", provenance: "Founder interview" },
  summary: "ExampleTutor offers online mathematics tutoring. Interested parents struggle to choose a first session.",
  constraint: {
    statement: "Parents cannot confidently choose and book a suitable first tutoring session.",
    lever_family: "activation", confidence: "medium",
    evidence: 'The founder reports: "parents ask which tutor to choose before booking"; the booking page lists tutors without a level guide.',
  },
  goal: { objective: "Reach 20 first paid tutoring sessions by Nov 30", target_metric: "new_customers", target_value: 20, due_date: "2026-11-30" },
  target_rationale: "Treat 20 as a proposed experiment target, not a forecast. Count first paid sessions in week one and confirm whether capacity supports it.",
  also_fix: "Add a level guide and show available first-session slots beside each tutor.",
  channel_bets: [
    { channel_slug: "seo", intent: "Publish one guide matching school maths levels to tutors, linked directly to available sessions.", rationale: "Answer the choice question parents already ask.", expected_effect: "Aim for 10 first bookings from the guide in 30 days; this is a hypothesis.", falsifier: "Fewer than 3 first bookings from the guide" },
    { channel_slug: "google_ads", intent: "After founder approval and a budget decision, test local maths-tutor searches against the improved booking page.", rationale: "Reach parents already looking for help.", expected_effect: "Test whether paid search contributes 10 first sessions in 30 days; do not spend before permission.", falsifier: "Fewer than 3 first sessions by day 30" },
  ],
  first_steps: [
    { when: "Day 1", step: "Count first paid sessions and review five recent parent enquiries." },
    { when: "Days 2–3", step: "Publish the tutor level guide and check the booking path with three parents." },
    { when: "Week 1", step: "Confirm tutoring capacity, revise the target if needed, and ask for the paid-search budget." },
  ],
  gaps: ["Current first-session count and available tutoring capacity are unknown."],
  unmeasured: [], basis_evidence: [],
};

const payload = {
  interview: [{ question: "Where do parents get stuck?", answer: "parents ask which tutor to choose before booking" }],
  research: { pages: [{ url: "https://example.com/tutors", text: "ExampleTutor offers online mathematics tutoring. The booking page lists tutors without a level guide. No customer count or revenue figure was available." }] },
};

export type StrategyReviewCase = { id: string; description: string; strategy: ParsedStrategy; payload: Record<string, unknown>; tools?: ReviewToolEvidence[] };
export const STRATEGY_REVIEW_CASES: StrategyReviewCase[] = [
  { id: "missing-check-date", description: "Date a channel failure test without losing the other commitments.", strategy: structuredClone(base), payload },
  { id: "unsupported-revenue", description: "An unsupported company revenue claim requires a full revision, never a section shortcut.", strategy: { ...structuredClone(base), summary: "ExampleTutor earns $930000 annually from mathematics tutoring." }, payload },
  { id: "missing-goal", description: "Restore a measurable goal while checking capacity and honest uncertainty.", strategy: { ...structuredClone(base), goal: null }, payload },
];
