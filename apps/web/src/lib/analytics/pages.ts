
export type PageGroup = "marketing" | "share" | "onboarding" | "app";
export type PageInfo = { type: string; group: PageGroup };

const EXACT: Record<string, PageInfo> = {
  "/": { type: "home", group: "marketing" },
  "/pricing": { type: "pricing", group: "marketing" },
  "/startups": { type: "startups", group: "marketing" },
  "/starters": { type: "starters", group: "marketing" },
  "/tools": { type: "tools", group: "marketing" },
  "/growth": { type: "leaderboard", group: "marketing" },
  "/use-cases": { type: "use_cases", group: "marketing" },
  "/channels": { type: "channels", group: "marketing" },
  "/blog": { type: "blog", group: "marketing" },
  "/affiliates": { type: "affiliates", group: "marketing" },
  "/about": { type: "about", group: "marketing" },
  "/support": { type: "support", group: "marketing" },
  "/tutorials": { type: "tutorials", group: "marketing" },
  "/why": { type: "about", group: "marketing" },
  "/fleet": { type: "about", group: "marketing" },
  "/upcar": { type: "about", group: "marketing" },
  "/talk-to-team": { type: "about", group: "marketing" },
  "/careers": { type: "careers", group: "marketing" },
  "/security": { type: "security", group: "marketing" },
  "/launch-video": { type: "launch_video", group: "marketing" },
  "/creators": { type: "creators", group: "marketing" },
  "/creators/apply": { type: "creator_apply", group: "onboarding" },
  "/humans/apply": { type: "creator_apply", group: "onboarding" },
  "/integrations/google-ads": { type: "integration", group: "marketing" },
  "/docs/ai-clients": { type: "docs", group: "marketing" },
  "/privacy": { type: "legal", group: "marketing" },
  "/terms": { type: "legal", group: "marketing" },
  "/cookie-policy": { type: "legal", group: "marketing" },
  "/legal/data-deletion": { type: "legal", group: "marketing" },
  "/legal/subprocessors": { type: "legal", group: "marketing" },
  "/mascot-preview": { type: "mascot_preview", group: "marketing" },
  "/start": { type: "onboarding_start", group: "onboarding" },
  "/login": { type: "login", group: "onboarding" },
  "/creators/login": { type: "creator_login", group: "onboarding" },
  "/reset-password": { type: "reset_password", group: "onboarding" },
  "/onboarding/past-work": { type: "onboarding_past_work", group: "onboarding" },
  "/shopify/app-home": { type: "shopify_app_home", group: "app" },
  "/shopify/pricing": { type: "shopify_pricing", group: "marketing" },
};

const PREFIXES: Array<[string, PageInfo]> = [
  ["/use-cases/", { type: "use_case", group: "marketing" }],
  ["/compare/", { type: "compare", group: "marketing" }],
  ["/blog/", { type: "blog_post", group: "marketing" }],
  ["/channels/", { type: "channel", group: "marketing" }],
  ["/humans/apply/", { type: "creator_apply", group: "onboarding" }],
  ["/launch-video/", { type: "launch_video", group: "marketing" }],
  ["/live/", { type: "live_report", group: "share" }],
  ["/r/", { type: "shared_result", group: "share" }],
  ["/c/", { type: "candidate_apply", group: "share" }],
  ["/invite/", { type: "invite", group: "onboarding" }],
  ["/reset-password/", { type: "reset_password", group: "onboarding" }],
];

export function pageInfo(pathname: string): PageInfo | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (EXACT[path]) return EXACT[path];
  for (const [prefix, info] of PREFIXES) {
    if (path.startsWith(prefix)) return info;
  }
  return null;
}

const APP_SECTIONS = new Set(["runs", "members", "settings", "email-cards", "legacy"]);

export function appPageInfo(pathname: string): PageInfo | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/workspace") return { type: "workspace", group: "app" };
  if (!path.startsWith("/workspace/")) return null;
  const section = path.split("/")[2] ?? "";
  return { type: APP_SECTIONS.has(section) ? `workspace_${section.replace("-", "_")}` : "workspace_thread", group: "app" };
}
