// @vitest-environment jsdom
import { Children, isValidElement, type ReactElement } from "react";
import { expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ href: "/start" }));
vi.mock("@/lib/resolveCta", () => ({ resolveMarketingSession: async () => ({ cta: { href: h.href, label: "Get started" }, email: null }) }));
vi.mock("@/lib/marketing/liveUpcar", () => ({ getLivePillSlug: async () => null }));
vi.mock("@/lib/marketing/iosAppStatus", () => ({ getIosAppStoreLive: async () => false }));
vi.mock("@/lib/marketing/pricing", () => ({ getLivePricing: async () => ({ freeDailyCredits: 0 }) }));
vi.mock("next/font/local", () => ({ default: () => ({ className: "", variable: "", style: {} }) }));
import Home from "./page";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import MeetWithZavi from "@/components/marketing/MeetWithZavi";
import { ZaviTestBubble } from "@/components/marketing/ZaviTestBubble";
import { GrowthHero } from "@/components/marketing/growth-home/GrowthHero";

it.each(["/start", "/workspace"])("tags the homepage signup doors while preserving %s session routing", async (href) => {
  h.href = href;
  const page = await Home({ searchParams: Promise.resolve({ utm_source: "x", utm_medium: "social", utm_campaign: "launch2" }) });
  const children = Children.toArray(page.props.children).filter(isValidElement) as ReactElement<Record<string, unknown>>[];
  const header = children.find((el) => el.type === GrowthHeader)!;
  const hero = children.find((el) => el.type === GrowthHero)!;
  const tagged = "/start?utm_source=x&utm_medium=social&utm_campaign=launch2";
  expect(header.props.cta).toMatchObject({ href: href === "/start" ? tagged : "/workspace" });
  expect(hero.props.startHref).toBe(tagged);
  for (const type of [MeetWithZavi, ZaviTestBubble]) {
    expect(children.find((el) => el.type === type)?.props.startHref).toBe(tagged);
  }
  expect(header.props.loginHref).toBe(`/login?${new URLSearchParams({ next: tagged.replace("/start", "/workspace") })}`);
});
