// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/fonts", () => ({ inter: {}, jakarta: {}, lato: {} }));
vi.mock("@/lib/marketing/useLiveStats", () => ({ prefetchLiveStats: vi.fn(), useLiveStats: () => ({}) }));
vi.mock("motion/react", async (original) => ({
  ...await original<typeof import("motion/react")>(),
  useReducedMotion: () => true,
}));
import MeetWithZavi from "./MeetWithZavi";
import { ZaviTestBubble } from "./ZaviTestBubble";
import { GrowthHeader } from "./growth-home/GrowthHeader";

const tagged = "/start?utm_source=x&utm_medium=creator&utm_campaign=launch2&utm_content=creator_alex";
beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([tagged, "/start"])("every chat-platform signup button keeps %s", (startHref) => {
  render(<MeetWithZavi startHref={startHref} />);
  for (const tab of ["Slack", "Microsoft Teams", "WhatsApp", "Telegram"]) {
    fireEvent.click(screen.getByRole("button", { name: tab }));
    expect(screen.getByRole("link").getAttribute("href")).toBe(startHref);
  }
});

it.each([tagged, "/start"])("the finished demo signup keeps %s", (startHref) => {
  render(<ZaviTestBubble freeDailyCredits={100} startHref={startHref} />);
  fireEvent.click(screen.getByRole("button", { name: /See Zavi build/i }));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: /More signups/i }));
  expect(screen.getByRole("link", { name: /Start free/ }).getAttribute("href")).toBe(startHref);
});

it("desktop and mobile sign-in preserve the signup return path", () => {
  const loginHref = `/login?${new URLSearchParams({ next: tagged.replace("/start", "/workspace") })}`;
  render(<GrowthHeader cta={{ href: tagged, label: "Get started" }} email={null} loginHref={loginHref} />);
  expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(loginHref);
  fireEvent.click(screen.getByRole("button", { name: /Open navigation/i }));
  expect(screen.getAllByRole("link", { name: "Sign in" })).toHaveLength(2);
  for (const link of screen.getAllByRole("link", { name: "Sign in" })) expect(link.getAttribute("href")).toBe(loginHref);
});
