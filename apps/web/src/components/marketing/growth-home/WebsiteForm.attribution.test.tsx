// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("./fonts", () => ({ jakartaHeavy: { className: "" } }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: vi.fn() }));
import { WebsiteForm } from "./GrowthHero";
import { LiveSiteBox, LiveSiteBar } from "@/app/live/[slug]/_components/LiveSiteBox";

afterEach(() => { cleanup(); push.mockClear(); window.history.replaceState({}, "", "/"); });

it.each(["", "example.com"])("preserves channel landing tags when submitting website %j", (site) => {
  window.history.replaceState({}, "", "/channels/google-ads?from=filter-coffee&utm_source=newsletter&utm_campaign=launch2");
  render(<WebsiteForm startHref="/start" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: site } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  const next = new URL(push.mock.calls[0][0], window.location.origin);
  expect(next.pathname).toBe("/start");
  expect(next.searchParams.get("from")).toBe("filter-coffee");
  expect(next.searchParams.get("utm_source")).toBe("newsletter");
  expect(next.searchParams.get("utm_campaign")).toBe("launch2");
  expect(next.searchParams.get("website")).toBe(site || null);
});

it("preserves an explicit destination campaign instead of mixing campaigns", () => {
  window.history.replaceState({}, "", "/channels?utm_source=newsletter&utm_campaign=launch2");
  render(<WebsiteForm startHref="/start?utm_source=partner" />);
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  const next = new URL(push.mock.calls[0][0], window.location.origin);
  expect(next.searchParams.get("utm_source")).toBe("partner");
  expect(next.searchParams.has("utm_campaign")).toBe(false);
});

it.each(["hero", "bar"])("preserves UTM tags and the live entry marker on the %s form", (placement) => {
  window.history.replaceState({}, "", "/live/upcar?from=newsletter&utm_source=email&utm_campaign=launch2");
  render(placement === "hero" ? <LiveSiteBox slug="upcar" starterUsd={20} /> : <LiveSiteBar slug="upcar" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "example.com" } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  const next = new URL(push.mock.calls[0][0], window.location.origin);
  expect(next.searchParams.get("from")).toBe("live-upcar");
  expect(next.searchParams.get("utm_source")).toBe("email");
  expect(next.searchParams.get("utm_campaign")).toBe("launch2");
  expect(next.searchParams.get("website")).toBe("example.com");
});
