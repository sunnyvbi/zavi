import { describe, expect, it } from "vitest";
import { isOnboardingNext, onboardingLoginHref, pastWorkModeHref, websiteResearchHref, websiteSignupNext, WORKSPACE_CONNECT_APPS_ROUTE } from "./onboardingRoutes";

describe("onboarding URLs", () => {
  it("keeps the pre-signup website screen separate from the signup return", () => {
    const params = new URLSearchParams("resume=website&new=1&from=live-demo");
    const research = new URL(websiteResearchHref("example.com", params), "https://zavi.test");
    expect(research.searchParams.has("resume")).toBe(false);
    expect(research.searchParams.get("website")).toBe("example.com");
    expect(research.searchParams.get("new")).toBe("1");
    expect(websiteSignupNext("example.com", research.searchParams)).toContain("resume=website");
    expect(WORKSPACE_CONNECT_APPS_ROUTE).toBe("/workspace?tab=growth-strategy&setupStep=connect-apps");
  });
  it("carries the public website through the existing signup callback", () => {
    const next = websiteSignupNext("example.com", new URLSearchParams("step=website&new=1&from=live-demo&ref=challenge&plan=growth&term=6mo"));
    const url = new URL(onboardingLoginHref(next), "https://zavi.test");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("signup")).toBe("1");
    expect(new URL(url.searchParams.get("next")!, "https://zavi.test").pathname).toBe("/onboarding/past-work");
    expect(Object.fromEntries(new URL(url.searchParams.get("next")!, "https://zavi.test").searchParams)).toEqual({ new: "1", from: "live-demo", ref: "challenge", website: "example.com", resume: "website" });
  });
  it("changes the past-work mode without changing the thread, workspace tab or hash", () => {
    const params = new URLSearchParams("tab=brain&thread=new&agent=cgo");
    expect(pastWorkModeHref("/workspace", params, "files", "#skills")).toBe("/workspace?tab=brain&thread=new&agent=cgo&pastWork=files#skills");
    params.set("pastWork", "files");
    expect(pastWorkModeHref("/workspace/thread-id", params, "paste", "#goals")).toBe("/workspace/thread-id?tab=brain&thread=new&agent=cgo#goals");
  });

  it("treats the website flow's Past work login target as onboarding", () => {
    const next = websiteSignupNext("example.com", new URLSearchParams("scan=s1"));
    expect(isOnboardingNext(next)).toBe(true);
    expect(isOnboardingNext("/start?step=idea")).toBe(true);
    expect(isOnboardingNext("/workspace")).toBe(false);
    expect(isOnboardingNext(null)).toBe(false);
  });
});
