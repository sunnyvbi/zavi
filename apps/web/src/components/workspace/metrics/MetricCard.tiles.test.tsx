// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AtSign } from "lucide-react";
import { MetricCard, PacingCard } from "./MetricCard";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import { redditKpisToMetrics } from "../agent/legacyChannelActions";

const metric = (over: Partial<ChannelMetric> = {}): ChannelMetric =>
  ({
    key: "reply_opportunities",
    value: 0,
    unit: "count",
    prev_value: null,
    prev_day: null,
    day: "2026-09-21",
    grounded: true,
    ...over,
  }) as ChannelMetric;

const label = () =>
  document.querySelector(
    '[data-metric="reply_opportunities"] span',
  ) as HTMLElement;
const number = (key = "reply_opportunities") =>
  document.querySelector(`[data-metric="${key}"] p`) as HTMLElement;
const unscoped = (cls: string) => new RegExp(`(^|\\s)${cls}(\\s|$)`);

afterEach(cleanup);

describe("a Reddit number that was not scanned", () => {
  it("draws a dash and the reason, never the -100% a zero against yesterday would make", () => {
    const rows = redditKpisToMetrics({
      insights: {
        has_data: true,
        kpis: {
          brand_mentions: { value: 0, previous: 20, brand_terms: 1, scanned: 0 },
          reply_opportunities: { value: 3, previous: 2, on_google: null },
          relevant_posts: { value: 0, previous: 9, scanned: 0 },
          relevant_comments: { value: 0, previous: 5, scanned: 0 },
          subreddits: { value: 2, top: null },
        },
      },
    } as unknown as Parameters<typeof redditKpisToMetrics>[0]);
    for (const [key, reason] of [["relevant_posts", "Not scanned today"], ["brand_mentions", "Not scanned this week"]] as const) {
      cleanup();
      render(<MetricCard metric={rows.find((m) => m.key === key)!} label={key} />);
      const tile = document.querySelector(`[data-metric="${key}"]`) as HTMLElement;
      expect(tile.textContent).toContain(reason);
      expect(tile.textContent).toContain("-");
      expect(tile.textContent).not.toMatch(/%/);
    }
  });

  it("keeps the name on one word boundary instead of hyphenating it", () => {
    render(<MetricCard metric={metric()} label="Reply opportunities" />);
    const el = label();
    expect(el.className).toContain("break-normal");
    expect(el.className).toContain("[hyphens:none]");
    expect(el.className).not.toMatch(unscoped("break-words"));
  });
});

describe("the tile, phone shape only", () => {
  it("wraps the label to two whole-word lines on a phone instead of cutting it mid-word", () => {
    render(<MetricCard metric={metric()} label="Reply opportunities" icon={AtSign} />);
    const el = label();
    expect(el.className).toContain("compact:line-clamp-2");
    expect(el.className).not.toContain("compact:truncate");
    expect(el.className).toContain("break-normal");
    expect(el.className).toContain("text-[14px]");
    expect(el.className).toContain("font-semibold");
    expect(el.className).not.toMatch(unscoped("text-\\[13px\\]"));
    expect(el.textContent).toBe("Reply opportunities");
  });

  it("mutes nothing-to-report only on a phone, in every shape of nothing", () => {
    for (const value of [0, null, undefined]) {
      cleanup();
      render(
        <MetricCard
          metric={metric({ value: value as unknown as number })}
          label="Reply opportunities"
        />,
      );
      expect(number().className).toContain("compact:text-inkMuted");
      expect(number().className).not.toMatch(unscoped("text-inkMuted"));
      expect(number().className).toMatch(unscoped("text-ink"));
      expect(number().className).toContain("text-[22px]");
      expect(number().className).toContain("font-bold");
    }
  });

  it("keeps a seven-figure headline inside the tile beside its delta", () => {
    render(
      <MetricCard
        metric={metric({ key: "spend", value: 1234567, unit: "usd", prev_value: 1000000 })}
        label="Spend"
      />,
    );
    const headline = number("spend");
    expect(headline.textContent).toMatch(/1,234,567|1\.2M/);
    expect(headline.className).toMatch(unscoped("min-w-0"));
    expect(headline.className).toMatch(unscoped("truncate"));
    expect(headline.className).toMatch(unscoped("text-\\[22px\\]"));
    expect(headline.className).not.toMatch(/compact:text-\[2[4-9]px\]/);
    const row = headline.parentElement as HTMLElement;
    expect(row.className).toMatch(unscoped("flex"));
    expect(row.className).toMatch(unscoped("min-w-0"));
    const delta = screen.getByTestId("delta-spend");
    expect(delta.parentElement).toBe(row);
  });

  it("does not mute a real number on either surface", () => {
    for (const value of [1, 0.4, -3]) {
      cleanup();
      render(<MetricCard metric={metric({ value })} label="Reply opportunities" />);
      expect(number().className).toMatch(unscoped("text-ink"));
      expect(number().className).not.toContain("text-inkMuted");
    }
  });

  it("gives the picked tile a surface on a phone and the desktop outline still", () => {
    render(
      <MetricCard
        metric={metric({ value: 12 })}
        label="Reply opportunities"
        select={{ selected: true, onSelect: () => {}, controls: "panel" }}
      />,
    );
    const tile = screen.getByRole("tab");
    expect(tile.className).toContain("compact:bg-bone");
    expect(tile.className).not.toMatch(unscoped("bg-bone"));
    expect(tile.className).toMatch(/(^|\s)border-ink(\s|$)/);
    expect(tile.getAttribute("aria-selected")).toBe("true");
  });

  it("leaves an unpicked tile on the plain surface", () => {
    render(
      <MetricCard
        metric={metric({ value: 12 })}
        label="Reply opportunities"
        select={{ selected: false, onSelect: () => {}, controls: "panel" }}
      />,
    );
    const tile = screen.getByRole("tab");
    expect(tile.className).toContain("border-rule");
    expect(tile.className).not.toContain("bg-bone");
  });
});

describe("a tile with nothing measured", () => {
  const blank = metric({ key: "pacing", value: Number.NaN, unmeasured: "Fills in once connected" });
  it("the pacing card shows a dash and the reason, and only the bar reads 0", () => {
    render(<PacingCard metric={blank} />);
    expect(screen.getByTestId("value-pacing").textContent).toBe("-");
    expect(screen.getByText("Fills in once connected")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  });
  it("the detail card shows a dash and the reason, not the previous-run line", () => {
    render(<MetricCard metric={blank} variant="detail" label="Spend" />);
    expect(screen.getByTestId("value-pacing").textContent).toBe("-");
    expect(screen.getByText("Fills in once connected")).toBeTruthy();
    expect(screen.queryByText("No earlier run to compare")).toBeNull();
  });
});

describe("a tile with nothing measured yet", () => {
  const blank = metric({ value: Number.NaN, unmeasured: true });
  const captions = () => Array.from(document.querySelectorAll('[data-metric] p')).filter((p) => p !== number() && !p.querySelector("[data-testid]"));

  it.each([
    ["plain", () => render(<MetricCard metric={blank} label="Reply opportunities" />)],
    ["detail", () => render(<MetricCard metric={blank} label="Reply opportunities" variant="detail" sub="Last 7 days" />)],
    ["scored", () => render(<MetricCard metric={{ ...blank, note: undefined, tone: "good" }} label="Reply opportunities" />)],
    ["pacing", () => render(<PacingCard metric={{ ...blank, key: "reply_opportunities" }} label="Spend vs budget" sub="Plan to date" />)],
  ])("%s: draws a dash and no caption under it", (_name, mount) => {
    mount();
    const tile = document.querySelector("[data-metric]") as HTMLElement;
    expect(tile.textContent).toContain("-");
    expect(tile.textContent).not.toMatch(/NaN|Not measured yet|Last 7 days|Plan to date|No earlier run|0%/);
    expect(captions().map((p) => p.textContent).filter(Boolean)).toEqual([]);
  });

  it("still shows a reason when there is one", () => {
    render(<MetricCard metric={metric({ value: Number.NaN, unmeasured: "Fills in once connected" })} label="Reply opportunities" />);
    expect(document.querySelector("[data-metric]")!.textContent).toContain("Fills in once connected");
  });
});

describe("a row of tiles lines up its values", () => {
  it.each([
    ["measured", metric({ value: 12 })],
    ["unmeasured", metric({ value: Number.NaN, unmeasured: true })],
    ["unmeasured with a reason", metric({ value: Number.NaN, unmeasured: "Fills in once connected" })],
    ["scored", metric({ value: 40, outOf: { max: 100 }, tone: "good" } as Partial<ChannelMetric>)],
  ])("%s: the tile is a column and its value row is pushed to the bottom, so a two-line label does not lower it", (_name, m) => {
    render(<MetricCard metric={m} label="People emailed this month" />);
    const tile = document.querySelector("[data-metric]") as HTMLElement;
    expect(tile.className).toMatch(unscoped("flex-col"));
    const row = tile.querySelector("[data-metric-value-row]") as HTMLElement;
    expect(row.className).toMatch(unscoped("mt-auto"));
    expect(row.className).not.toMatch(/(^|\s)mt-(?!auto)/);
  });
});
