
export type OnboardedStatus = "loading" | "needed" | "done";

export type CreatorProbe = "loading" | "creator" | "not_creator";

export type AppPhase = "wait" | "auth" | "onboarding" | "creator" | "chat";

export function appPhase(input: {
  signedIn: boolean;
  onboarding: OnboardedStatus;
  creator: CreatorProbe;
}): AppPhase {
  if (!input.signedIn) return "auth";
  if (input.onboarding === "loading") return "wait";
  if (input.onboarding === "done") return "chat";
  if (input.creator === "loading") return "wait";
  return input.creator === "creator" ? "creator" : "onboarding";
}

export type ConsentStatus = "loading" | "agreed" | "needed" | "declined";

export type SetupGateStatus = "loading" | "active" | "inactive";

export type GatePhase = AppPhase | "consent" | "setup";

export function gatePhase(input: {
  phase: AppPhase;
  consent: ConsentStatus;
  setup: SetupGateStatus;
}): GatePhase {
  const { phase } = input;
  if (phase !== "onboarding" && phase !== "chat") return phase;
  if (input.consent === "loading") return "wait";
  if (input.consent === "needed") return "consent";
  if (phase === "onboarding") return input.consent === "declined" ? "consent" : "onboarding";
  if (input.consent === "declined") return "chat";
  if (input.setup === "loading") return "wait";
  return input.setup === "active" ? "setup" : "chat";
}

export const PHASE_ROUTE = {
  auth: "/(auth)/welcome",
  consent: "/consent",
  onboarding: "/(onboarding)/website",
  setup: "/growth-setup",
  creator: "/creator",
  chat: "/chat",
} as const;

export const CREATOR_TABS: { path: string; label: string }[] = [
  { path: "/creator", label: "Inbox" },
  { path: "/creator/briefs", label: "Briefs" },
  { path: "/creator/jobs", label: "Jobs" },
  { path: "/creator/earnings", label: "Earnings" },
  { path: "/creator/storefront", label: "Storefront" },
];

export function isCreatorPath(pathname: string): boolean {
  return pathname === "/creator" || pathname.startsWith("/creator/");
}

export function activeCreatorTab(pathname: string): string {
  if (pathname === "/creator") return "/creator";
  const hit = CREATOR_TABS.filter((t) => t.path !== "/creator").find(
    (t) => pathname === t.path || pathname.startsWith(`${t.path}/`),
  );
  return hit ? hit.path : "/creator";
}

export function creatorLinkTarget(linkPath: string | null): string | null {
  if (!linkPath || !linkPath.startsWith("/creator")) return null;
  if (linkPath.includes("?") || linkPath.includes("#")) return null;
  if (CREATOR_TABS.some((t) => t.path === linkPath)) return linkPath;
  const job = /^\/creator\/jobs\/([A-Za-z0-9-]+)$/.exec(linkPath);
  return job ? linkPath : null;
}
