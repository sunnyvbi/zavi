
export type SetupQuestionKey = "metric" | "constraint" | "channels" | "customers";

export type SetupQuestion = {
  key: SetupQuestionKey;
  question: string;
  why: string;
  options: readonly string[];
  multi?: boolean;
  optional?: boolean;
};

export const QUESTIONS_TITLE = "Your business today";
export const QUESTIONS_SUBTITLE = "A few things only you know. Tap the closest answer.";
export const QUESTIONS_PICK_ANY = "Pick any that fit.";
export const QUESTIONS_PICK_ANY_SHORT = "Pick any";
export const SETUP_STEP_KEYS: readonly SetupQuestionKey[] = ["metric", "constraint", "channels"];
export const QUESTIONS_OPTIONAL = "Optional";
export const QUESTIONS_SAVING = "Starting your strategy…";
export const QUESTIONS_SKIPPING = "Skipping…";
export const QUESTIONS_FINISH = "Build my strategy";
export const QUESTIONS_SAVE_FAILED = "Some answers didn't save. Try again, or Skip to build your strategy with the ones that did.";
export const PREVIEW_EYEBROW = "Your first strategy · Draft";
export const PREVIEW_EMPTY = "Your answers write the plan";
export const PREVIEW_WRITING = "Zavi is writing it with you…";
export const PREVIEW_READY = "Ready to build";
export const PREVIEW_GOAL = "Goal";
export const PREVIEW_BLOCKER = "Holding you back";
export const PREVIEW_START = "Start with";
export const PREVIEW_NOT_ANSWERED = "Not answered yet";
export const QUESTIONS_STEPS_LABEL = "Questions";
export const QUESTIONS_STEP_ANSWERED = "answered";
export const QUESTIONS_STEP_LABELS: Partial<Record<SetupQuestionKey, string>> = { metric: PREVIEW_GOAL, constraint: PREVIEW_BLOCKER, channels: PREVIEW_START };

export const PREVIEW_GOALS: Record<string, { text: string; measure: string }> = {
  "More people finding us": { text: "More people finding you", measure: "Measured by new visitors a month" },
  "More of them actually buying": { text: "More visitors becoming customers", measure: "Measured by how many visitors buy" },
  "Customers worth more": { text: "Customers worth more", measure: "Measured by revenue per customer" },
  "Customers staying longer": { text: "Customers staying longer", measure: "Measured by how many come back" },
  "More sellers or suppliers on our side": { text: "More sellers and suppliers on your side", measure: "Measured by active sellers and suppliers" },
};
export const PREVIEW_BLOCKERS: Record<string, { text: string; fix: string }> = {
  "They never hear about us": { text: "People never hear about you.", fix: "Zavi starts by getting you seen, on search and social." },
  "They look, but don't buy": { text: "People look, but don't buy.", fix: "Zavi fixes your offer and checkout before bringing in more people." },
  "They sign up, then never get going": { text: "People sign up, then never get going.", fix: "Zavi starts with nudges that get them to their first win." },
  "They buy once and don't come back": { text: "Customers buy once and don't come back.", fix: "Zavi starts with follow-ups and offers that bring buyers back." },
  "We can't keep up with the demand we have": { text: "You can't keep up with demand.", fix: "Zavi helps you choose the best customers before bringing in more." },
  "Honestly, I'm not sure": { text: "Not clear yet.", fix: "Zavi looks at your site and numbers in week one to find it." },
};
export const PREVIEW_STARTS: Record<string, string> = {
  "Someone I already knew": "Your network: ask the people you know for intros",
  "I reached out to them myself": "More of the outreach that already worked",
  "Word of mouth from a customer": "A referral offer for happy customers",
  "They searched and found us": "Your Google listing and search pages",
  "We paid for ads": "Your ads: cut what doesn't sell, grow what does",
  "Saw us on social": "Social posts and Reels, 3 a week",
  "Nothing repeatable yet": "Two channels, tested side by side",
};
export const CHANNELS_NONE = "Nothing repeatable yet";

export const SETUP_QUESTIONS: readonly SetupQuestion[] = [
  {
    key: "metric",
    question: "If one thing got better over the next 3 months, what should it be?",
    why: "Everything Zavi does gets judged on whether it moved this.",
    options: ["More people finding us", "More of them actually buying", "Customers worth more", "Customers staying longer", "More sellers or suppliers on our side"],
  },
  {
    key: "constraint",
    question: "Where do you lose people?",
    why: "This is the one thing Zavi will try hardest to fix.",
    options: ["They never hear about us", "They look, but don't buy", "They sign up, then never get going", "They buy once and don't come back", "We can't keep up with the demand we have", "Honestly, I'm not sure"],
  },
  {
    key: "channels",
    question: "Think about the last handful of customers. How did they find you?",
    why: "Whatever already worked is usually what's worth doing more of.",
    options: ["Someone I already knew", "I reached out to them myself", "Word of mouth from a customer", "They searched and found us", "We paid for ads", "Saw us on social", "Nothing repeatable yet"],
    multi: true,
  },
  {
    key: "customers",
    question: "Roughly how many new customers did you get last month?",
    why: "Gives your goal a real starting number instead of a guess.",
    options: ["0", "1-5", "6-20", "21-100", "100+", "Not sure"],
    optional: true,
  },
];
