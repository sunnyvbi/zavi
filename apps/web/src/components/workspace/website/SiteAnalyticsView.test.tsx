// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import {
  ANALYTICS_FOOTNOTE,
  ANALYTICS_NO_FORMS_TITLE,
  ANALYTICS_NOT_LIVE,
  ANALYTICS_NO_VISITS,
  analyticsUrl,
  conversionText,
  sourceLabel,
  changeText,
  SiteAnalyticsView,
  type SiteAnalyticsPayload,
} from "./SiteAnalyticsView";
import { agoText } from "./siteDashboardFormat";

const BUILD = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const LIVE = "https://golden-fork-1a2b3c4d.zaviagent.com";

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function payload(over: Partial<SiteAnalyticsPayload> = {}): SiteAnalyticsPayload {
  return {
    state: "ready",
    range: { days: 7, tz: "UTC", from: "2026-10-01", to: "2026-10-07" },
    total: 8,
    previous_total: 5,
    all_time: 26,
    daily: ["01", "02", "03", "04", "05", "06", "07"].map((d, i) => ({ day: `2026-10-${d}`, count: i === 1 ? 2 : i === 6 ? 6 : 0 })),
    forms: [
      { collection: "class_signups", label: "Class signups", kind: "booking", count: 5, previous: 0, all_time: 5, last_at: new Date(Date.now() - 2 * 3600_000).toISOString() },
      { collection: "enquiries", label: "Enquiries", kind: "form", count: 3, previous: 5, all_time: 21, last_at: null },
    ],
    traffic: {
      visits: 40,
      previous_visits: 25,
      pageviews: 96,
      conversion: 0.2,
      daily: ["01", "02", "03", "04", "05", "06", "07"].map((d, i) => ({ day: `2026-10-${d}`, visits: i === 6 ? 30 : i === 1 ? 10 : 0, pageviews: 0 })),
      pages: [{ path: "/", pageviews: 60, visits: 38 }, { path: "/classes", pageviews: 36, visits: 20 }],
      sources: [{ source: null, visits: 22 }, { source: "www.google.com", visits: 14 }, { source: "spring_promo", visits: 4 }],
    },
    ...over,
  };
}

beforeEach(() => apiFetch.mockReset());
afterEach(() => cleanup());

describe("pure helpers", () => {
  it("asks for the session's site, range and the browser's zone", () => {
    expect(analyticsUrl(BUILD, 90, "America/New_York")).toBe(
      `/api/website/site-analytics?build_session_id=${BUILD}&days=90&tz=America%2FNew_York`,
    );
  });

  it("compares with the period before in plain words", () => {
    expect(changeText(8, 5, 7)).toBe("3 more than the previous 7 days");
    expect(changeText(2, 5, 30)).toBe("3 fewer than the previous 30 days");
    expect(changeText(4, 0, 7)).toBe("None in the previous 7 days");
    expect(changeText(3, 3, 7)).toBe("Same as the previous 7 days");
    expect(changeText(0, 0, 7)).toBe("None in the previous 7 days either");
  });

  it("writes conversion and sources the way people read them", () => {
    expect(conversionText(null)).toBe("No visits yet");
    expect(conversionText(0.2)).toBe("20%");
    expect(conversionText(0.034)).toBe("3.4%");
    expect(conversionText(0)).toBe("0%");
    expect(sourceLabel(null)).toBe("Direct");
    expect(sourceLabel("www.google.com")).toBe("google.com");
    expect(sourceLabel("spring_promo")).toBe("spring_promo");
  });

  it("says when the last one came in", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    expect(agoText(null, now)).toBe("Never");
    expect(agoText("2026-10-07T11:59:40Z", now)).toBe("Just now");
    expect(agoText("2026-10-07T10:00:00Z", now)).toBe("2 hours ago");
    expect(agoText("2026-10-06T08:00:00Z", now)).toBe("Yesterday");
    expect(agoText("2026-10-03T08:00:00Z", now)).toBe("4 days ago");
  });
});

describe("SiteAnalyticsView", () => {
  it("before the site is live: explains, and reads nothing", () => {
    render(<SiteAnalyticsView buildSessionId={BUILD} deployedUrl={null} />);
    expect(screen.getByText(ANALYTICS_NOT_LIVE)).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("shows visits, page views, submissions, conversion, every day, top pages and sources, and each form", async () => {
    apiFetch.mockResolvedValue(json(200, payload()));
    render(<SiteAnalyticsView buildSessionId={BUILD} deployedUrl={LIVE} />);
    expect(await screen.findByText("15 more than the previous 7 days")).toBeTruthy();
    expect(screen.getByText("3 more than the previous 7 days")).toBeTruthy();
    expect(screen.getByText("20%")).toBeTruthy();
    expect(screen.getByText("2.4 per visit")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Visits per day" }).querySelectorAll("li")).toHaveLength(7);
    expect(screen.getByLabelText("Oct 7: 30")).toBeTruthy();
    expect(screen.getByLabelText("Oct 2: 2")).toBeTruthy();
    expect(screen.getByLabelText("/classes: 36 page views")).toBeTruthy();
    expect(screen.getByLabelText("Direct: 22 visits")).toBeTruthy();
    expect(screen.getByLabelText("google.com: 14 visits")).toBeTruthy();
    expect(screen.getByText("Class signups")).toBeTruthy();
    expect(screen.getByText(/Booking · last one 2 hours ago/)).toBeTruthy();
    expect(screen.getByText(/Form · last one never/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /See the messages/ }).getAttribute("href")).toBe(`${LIVE}/admin`);
    expect(screen.getByText(ANALYTICS_FOOTNOTE)).toBeTruthy();
    expect(String(apiFetch.mock.calls[0][0])).toContain("days=30");
  });

  it("a site with no forms still shows its visits, with the no-forms state below", async () => {
    apiFetch.mockResolvedValue(json(200, payload({ state: "no_database", forms: [], total: 0, previous_total: 0, all_time: 0 })));
    render(<SiteAnalyticsView buildSessionId={BUILD} deployedUrl={LIVE} />);
    expect(await screen.findByText(ANALYTICS_NO_FORMS_TITLE)).toBeTruthy();
    expect(screen.getByText("Visits per day")).toBeTruthy();
    expect(screen.queryByText(/Submissions per day/)).toBeNull();
  });

  it("no visits yet: says so instead of an empty chart", async () => {
    const p = payload();
    apiFetch.mockResolvedValue(json(200, { ...p, traffic: { ...p.traffic, visits: 0, previous_visits: 0, pageviews: 0, conversion: null, pages: [], sources: [] } }));
    render(<SiteAnalyticsView buildSessionId={BUILD} deployedUrl={LIVE} />);
    expect(await screen.findByText(ANALYTICS_NO_VISITS)).toBeTruthy();
    expect(screen.queryByText("Visits per day")).toBeNull();
    expect(screen.getByText("–")).toBeTruthy();
  });

  it("switching the range reads that range and keeps the picker in place", async () => {
    apiFetch.mockResolvedValue(json(200, payload()));
    render(<SiteAnalyticsView buildSessionId={BUILD} deployedUrl={LIVE} />);
    await screen.findByText("Class signups");
    let resolve!: (r: Response) => void;
    apiFetch.mockReturnValueOnce(new Promise<Response>((r) => (resolve = r)));
    fireEvent.click(screen.getByRole("button", { name: "90 days" }));
    expect(screen.getByRole("button", { name: "90 days" }).getAttribute("aria-pressed")).toBe("true");
    expect(String(apiFetch.mock.calls.at(-1)?.[0])).toContain("days=90");
    await act(async () => resolve(json(200, payload({ range: { days: 90, tz: "UTC", from: "2026-07-10", to: "2026-10-07" } }))));
    expect((await screen.findByRole("button", { name: "90 days" })).getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByText("Class signups")).toBeTruthy();
  });

  it("shows the server's reason and retries", async () => {
    apiFetch.mockResolvedValueOnce(json(503, { error: { code: "analytics_updating", message: "Analytics are being set up for your site. Check back in a few minutes." } }));
    render(<SiteAnalyticsView buildSessionId={BUILD} deployedUrl={LIVE} />);
    expect(await screen.findByText(/being set up/)).toBeTruthy();
    apiFetch.mockResolvedValueOnce(json(200, payload()));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Class signups")).toBeTruthy();
  });
});
