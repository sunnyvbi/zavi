// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { GrowthStartIntake } from "./GrowthStartIntake";
import { WebsiteStartFlow } from "./WebsiteStartFlow";
const h = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(h.query) }));
vi.mock("next/font/local", () => ({ default: () => ({ variable: "test-font" }) }));
vi.mock("./WebsiteLearningPanel", () => ({ WebsiteLearningPanel: () => null }));
vi.mock("./WebsiteEntryNotices", () => ({ WebsiteEntryNotices: () => null }));
vi.mock("./useWebsiteOnboarding", () => ({ useWebsiteOnboarding: () => ({
  phase: "ready", website: "", changeWebsite: () => {}, submit: () => {}, error: null,
  addCompany: new URLSearchParams(h.query).get("new") === "1",
}) }));

vi.mock("next/image", () => ({
  default: ({ unoptimized, ...props }: ComponentProps<"img"> & { unoptimized?: boolean }) => <img {...props} />,
}));

afterEach(cleanup);

const mount = (addCompany?: boolean, consentNext?: string) =>
  render(<GrowthStartIntake website="" onWebsiteChange={() => {}} error={null} onContinue={() => {}} addCompany={addCompany} consentNext={consentNext} />);

describe("/start is not a dead end without a website", () => {
  it("keeps launch tags and consent return when the founder switches from website to idea", () => {
    h.query = `utm_source=x&utm_medium=creator&utm_campaign=launch2&utm_content=creator_alex&new=1&gclid=secret&next=${encodeURIComponent("/oauth/consent?req=abc")}`;
    render(<WebsiteStartFlow />);
    const href = screen.getByRole("link", { name: "Start from an idea" }).getAttribute("href")!;
    const params = new URL(href, "https://www.zaviagent.com").searchParams;
    expect(Object.fromEntries(params)).toEqual({ step: "idea", new: "1", next: "/oauth/consent?req=abc", utm_source: "x", utm_medium: "creator", utm_campaign: "launch2", utm_content: "creator_alex" });
  });
  it("offers the idea flow and sign-in", () => {
    mount();
    expect(screen.getByRole("link", { name: "Start from an idea" }).getAttribute("href")).toBe("/start?step=idea");
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  });
  it("hides sign-in from a founder who just signed in", () => {
    render(<GrowthStartIntake website="" onWebsiteChange={() => {}} error={null} onContinue={() => {}} signedIn />);
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(screen.getByRole("link", { name: "Start from an idea" })).toBeTruthy();
  });
  it("adding a second company keeps add-company mode and hides sign-in", () => {
    mount(true);
    expect(screen.getByRole("link", { name: "Start from an idea" }).getAttribute("href")).toBe("/start?step=idea&new=1");
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });
  it("an AI assistant's approval page survives the idea flow", () => {
    mount(false, "/oauth/consent?req=abc");
    expect(screen.getByRole("link", { name: "Start from an idea" }).getAttribute("href")).toBe(
      `/start?step=idea&next=${encodeURIComponent("/oauth/consent?req=abc")}`,
    );
  });
});
