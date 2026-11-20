// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ActionsEmpty, type ChannelRunInfo } from "./ChannelEmptyStates";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [] }) }) }) }),
    }),
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeChannel: () => {},
  }),
}));

afterEach(cleanup);
beforeEach(() => apiFetch.mockReset());

const runInfo = (over: Partial<ChannelRunInfo> = {}): ChannelRunInfo => ({
  slug: "reddit_organic",
  name: "Reddit",
  switched: false,
  priorCount: 0,
  foldBelow: false,
  onRan: () => {},
  ...over,
});

const GENERIC = /No suggestions for .* yet/i;

describe("a channel the plan chose speaks the plan's words", () => {
  it("shows the intent and the reason instead of the generic line", () => {
    render(
      <ActionsEmpty
        workState="idle"
        lastRunAt={null}
        run={runInfo()}
        planIntent="Answer buyer questions in r/usedcars"
        planRationale="Your buyers research there before they reach your site."
      />,
    );
    expect(screen.getByText("Answer buyer questions in r/usedcars")).toBeTruthy();
    expect(
      screen.getByText("Why: Your buyers research there before they reach your site."),
    ).toBeTruthy();
    expect(screen.queryByText(GENERIC)).toBeNull();
  });

  it("Flow 32: a terse lowercase plan note reads as a labelled sentence, not a raw fragment", () => {
    const { container } = render(
      <ActionsEmpty
        workState="idle"
        lastRunAt={null}
        run={runInfo({ slug: "email_marketing", name: "Email campaigns" })}
        planIntent="Send every new renter signup a three-email first week: welcome, how pickup works, first-trip offer"
        planRationale="  signups already here, no spend "
      />,
    );
    expect(screen.queryByText("signups already here, no spend")).toBeNull();
    const why = screen.getByText("Why: Signups already here, no spend.");
    expect(why.tagName).toBe("P");
    const lines = Array.from(container.querySelectorAll("p")).map((p) => p.textContent);
    expect(lines).toEqual([
      "Send every new renter signup a three-email first week: welcome, how pickup works, first-trip offer",
      "Why: Signups already here, no spend.",
    ]);
  });

  it("draws no second line when the reason is only whitespace", () => {
    const { container } = render(
      <ActionsEmpty workState="idle" lastRunAt={null} run={runInfo()} planIntent="Answer buyer questions in r/usedcars" planRationale="   " />,
    );
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  const reasonLine = (planRationale: string) => {
    const { container } = render(
      <ActionsEmpty workState="idle" lastRunAt={null} run={runInfo()} planIntent="Answer buyer questions in r/usedcars" planRationale={planRationale} />,
    );
    return Array.from(container.querySelectorAll("p")).map((p) => p.textContent).slice(1);
  };

  it.each([
    ["worth a look…", "Why: Worth a look…"],
    ['he said "go."', 'Why: He said "go."'],
    ["(see above.)", "Why: (see above.)"],
    ["really?”", "Why: Really?”"],
    ["[done!]", "Why: [done!]"],
    ["x,", "Why: X."],
    ["signups already here ; ", "Why: Signups already here."],
    ["cheap traffic:", "Why: Cheap traffic."],
  ])("ends %j with exactly one sentence stop", (input, expected) => {
    expect(reasonLine(input)).toEqual([expected]);
  });

  it.each([
    ["iPhone renters book here", "Why: iPhone renters book here."],
    ["eBay sellers list cars", "Why: eBay sellers list cars."],
    ["élan sells", "Why: Élan sells."],
    ["3x cheaper than ads", "Why: 3x cheaper than ads."],
    ["🚗 renters search here", "Why: 🚗 renters search here."],
    ["a cheap channel", "Why: A cheap channel."],
  ])("capitalises %j only when it is safe", (input, expected) => {
    expect(reasonLine(input)).toEqual([expected]);
  });

  it.each([
    ["why: signups are here", "Why: Signups are here."],
    ["WHY:signups are here", "Why: Signups are here."],
    ["Because signups are here", "Why: Signups are here."],
    ["because, signups are here", "Why: Signups are here."],
    ["Why: because signups are here", "Why: Signups are here."],
    ["Becauses are fine", "Why: Becauses are fine."],
    ["why this works: signups", "Why: Why this works: signups."],
  ])("never doubles the label for %j", (input, expected) => {
    expect(reasonLine(input)).toEqual([expected]);
  });

  it.each(["why:", "Because", "  because ;  "])("draws no reason line when %j is only a label", (input) => {
    expect(reasonLine(input)).toEqual([]);
  });

  it("still offers the run button, with its cost", () => {
    render(
      <ActionsEmpty
        workState="idle"
        lastRunAt={null}
        run={runInfo()}
        planIntent="Answer buyer questions in r/usedcars"
        planRationale={null}
      />,
    );
    expect(screen.getByRole("button", { name: /Get suggestions/ })).toBeTruthy();
  });

  it("draws no second line when there is no reason recorded", () => {
    const { container } = render(
      <ActionsEmpty
        workState="idle"
        lastRunAt={null}
        run={runInfo()}
        planIntent="Answer buyer questions in r/usedcars"
        planRationale={null}
      />,
    );
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });
});

describe("everything else renders exactly as before", () => {
  it("a channel the plan did not choose keeps the generic empty state", () => {
    render(<ActionsEmpty workState="idle" lastRunAt={null} run={runInfo()} planIntent={null} />);
    expect(screen.getByText(GENERIC)).toBeTruthy();
  });

  it("a tenant with no plan keeps the generic empty state", () => {
    render(<ActionsEmpty workState="idle" lastRunAt={null} run={runInfo()} />);
    expect(screen.getByText(GENERIC)).toBeTruthy();
  });

  it("a delivered channel does not show plan intent", () => {
    render(
      <ActionsEmpty
        workState="delivered"
        lastRunAt={null}
        run={runInfo()}
        planIntent="Answer buyer questions in r/usedcars"
      />,
    );
    expect(screen.queryByText("Answer buyer questions in r/usedcars")).toBeNull();
  });

  it("a failed run does not show plan intent", () => {
    render(
      <ActionsEmpty
        workState="needs_review"
        lastRunAt={null}
        run={runInfo()}
        planIntent="Answer buyer questions in r/usedcars"
      />,
    );
    expect(screen.queryByText("Answer buyer questions in r/usedcars")).toBeNull();
  });
});
