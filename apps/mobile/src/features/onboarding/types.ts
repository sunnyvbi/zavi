
export type Competitor = { name: string; domain: string };

export type OnboardingData = {
  website: string;
  noSite: boolean;
  workspace: string;
  description: string;
  audience: string;
  goal: string;
  competitors: Competitor[];
  notification: "later" | "allowed" | "denied";
};

export const BLANK: OnboardingData = {
  website: "",
  noSite: false,
  workspace: "",
  description: "",
  audience: "",
  goal: "",
  competitors: [],
  notification: "later",
};

export type Goal = { id: string; title: string; sub: string; mark: string };

export const GOALS: Goal[] = [
  { id: "social", title: "Grow my audience", sub: "Start with a useful social post", mark: "↗" },
  { id: "search", title: "Get found in search", sub: "Build a useful content outline", mark: "⌕" },
  { id: "ads", title: "Improve my ads", sub: "Make a clear campaign brief", mark: "◎" },
  { id: "launch", title: "Launch something new", sub: "Plan the first steps", mark: "✧" },
  { id: "time", title: "Get work off my plate", sub: "Turn an idea into an action plan", mark: "✓" },
];

export const MAX_COMPETITORS = 5;

export const LIMITS = {
  website: 200,
  workspace: 60,
  description: 500,
  idea: 4000,
  audience: 200,
  competitorName: 80,
  competitorDomain: 200,
} as const;
