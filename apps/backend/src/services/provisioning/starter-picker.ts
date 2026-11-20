
export type StarterCategory =
  | "todo"
  | "blog"
  | "dashboard"
  | "auth"
  | "shop"
  | "landing"
  | "generic";

export const STARTER_CATEGORIES: readonly StarterCategory[] = Object.freeze([
  "todo",
  "blog",
  "dashboard",
  "auth",
  "shop",
  "landing",
  "generic",
]);

type PickerRule = {
  category: StarterCategory;
  keywords: readonly string[];
  regexes?: readonly RegExp[];
};

const PICKER_RULES: readonly PickerRule[] = Object.freeze([
  {
    category: "todo",
    keywords: ["to-do", "todo", "to do list", "task list", "task manager", "task tracker", "checklist app"],
    regexes: [/\btasks?\b.*\b(app|manager|tracker|list)\b/, /\b(add|complete|delete)\b.*\btasks?\b/],
  },
  {
    category: "shop",
    keywords: [
      "shop",
      "store",
      "ecommerce",
      "e-commerce",
      "marketplace",
      "cart",
      "checkout",
      "product catalog",
      "storefront",
    ],
    regexes: [/\bsell\b.*\b(products?|items?|stuff|goods)\b/, /\bbuy\b.*\b(products?|items?)\b/],
  },
  {
    category: "blog",
    keywords: ["blog", "blogging", "cms", "articles", "posts", "publication", "newsletter site", "writers"],
    regexes: [/\bpublish(ing)?\b.*\b(posts?|articles?|stories)\b/],
  },
  {
    category: "dashboard",
    keywords: [
      "dashboard",
      "admin panel",
      "analytics",
      "kpi",
      "metrics",
      "reporting tool",
      "stats",
      "monitor",
      "internal tool",
    ],
    regexes: [/\b(charts?|graphs?)\b.*\b(app|tool|dashboard)\b/],
  },
  {
    category: "auth",
    keywords: [
      "auth",
      "authentication",
      "login",
      "signup",
      "sign-up",
      "sign up",
      "sign in",
      "sign-in",
      "registration",
      "user account",
      "accounts app",
    ],
    regexes: [/\bsign[- ]?in\b/, /\bsign[- ]?up\b/, /\buser\b.*\baccount\b/],
  },
  {
    category: "landing",
    keywords: [
      "landing page",
      "landing site",
      "marketing page",
      "marketing site",
      "splash page",
      "coming soon",
      "waitlist page",
      "product page",
      "homepage for",
      "one-pager",
    ],
    regexes: [/\bmarketing\b.*\bsite\b/, /\bhero\b.*\bsection\b/],
  },
]);

export function classifyPrompt(idea: string | null | undefined): StarterCategory {
  if (typeof idea !== "string") return "generic";
  const text = idea.trim().toLowerCase();
  if (!text) return "generic";

  for (const rule of PICKER_RULES) {
    for (const kw of rule.keywords) {
      if (text.includes(kw)) return rule.category;
    }
    if (rule.regexes) {
      for (const rx of rule.regexes) {
        if (rx.test(text)) return rule.category;
      }
    }
  }
  return "generic";
}
