
const DEFAULT_STARTERS: readonly string[] = [
  "What can you help me with?",
  "Summarize what you know about my business so far.",
  "What should I look at first?",
];

const BY_AGENT: Readonly<Record<string, readonly string[]>> = {
  "seo-geo": [
    "Why aren't we showing up in AI Overviews?",
    "Audit our homepage for SEO problems.",
    "Is our structured data set up correctly?",
  ],
  "performance-marketer": [
    "How are my ad campaigns performing this week?",
    "Where am I wasting ad spend?",
    "Draft a test plan for a new campaign.",
  ],
  "chief-of-staff": [
    "What needs my attention today?",
    "Summarize this week across the company.",
    "What are the biggest risks right now?",
  ],
  engineer: [
    "What's the riskiest part of our codebase?",
    "Draft a plan for a small feature.",
    "Review our recent changes for issues.",
  ],
  "dispute-response": [
    "Are there any open disputes I should know about?",
    "Draft a response to the latest chargeback.",
    "What evidence do we have for recent disputes?",
  ],
  cgo: [
    "Work on my growth plan",
    "What's actually holding my growth back?",
    "What should I focus on this week?",
    "What do you need from me to be useful?",
  ],
  "growth-lead": [
    "What's our biggest growth lever right now?",
    "Suggest 3 experiments to try this week.",
    "Where are users dropping off?",
  ],
  operator: [
    "What's on fire today?",
    "Summarize recent customer signals.",
    "What should I delegate this week?",
  ],
  "support-lead": [
    "What are customers complaining about most?",
    "Draft a reply to the latest support thread.",
    "Any trends I should worry about?",
  ],
  pm: [
    "What should be on our roadmap next?",
    "Summarize recent user feedback.",
    "What's the smallest valuable thing to ship?",
  ],
  qa: [
    "What should we test before the next release?",
    "Find gaps in our test coverage.",
    "What broke recently?",
  ],
  research: [
    "Research our top competitor's latest moves.",
    "What's changing in our market?",
    "Summarize the latest in our space.",
  ],
};

export function cannedQuestionsFor(agentSlug: string): readonly string[] {
  return BY_AGENT[agentSlug] ?? DEFAULT_STARTERS;
}
