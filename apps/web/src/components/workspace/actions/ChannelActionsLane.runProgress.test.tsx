// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChannelActionsLane } from "./ChannelActionsLane";
import { makeAction } from "./__tests__/fixtures";
import type { ChannelDetail } from "../layout/channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const eventRows = vi.hoisted(() => ({ value: [] as Array<{ stage: string; meta: unknown }> }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ order: () => ({ limit: async () => ({ data: eventRows.value }) }) }),
      }),
    }),
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeChannel: () => {},
  }),
}));

const SLUG = "linkedin_organic";
const RUN_ID = "11111111-1111-1111-1111-111111111111";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const card = makeAction("text_post", {
  id: "ca-1",
  channel_slug: SLUG,
  title: "The action the run has written so far",
});

function route({ actions = [card], lastRunId = RUN_ID as string | null } = {}) {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes(`/api/channels/${SLUG}/actions`)) {
      return ok({ actions, more: 0, store: "channel_actions" });
    }
    if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
    if (u.includes(`/api/channels/${SLUG}/history`)) {
      return ok({ runs: [], closed: [], pre_switch: [] });
    }
    if (u.endsWith(`/api/channels/${SLUG}/run`)) return ok({ ok: true, run_id: RUN_ID });
    if (u === "/api/channels") {
      return ok({
        channels: [{ channel_slug: SLUG, run_reserve_credits: 340, last_run_id: lastRunId }],
      });
    }
    return ok({});
  });
}

async function mount(workState: ChannelDetail["workState"], lastRunAt = new Date().toISOString()) {
  const r = render(
    <ChannelActionsLane
      slug={SLUG}
      legacy={<p>LEGACY RAIL</p>}
      workState={workState}
      lastRunAt={lastRunAt}
      actionCount={0}
      connected
      hasConnectors
    >
      <li>an approvals row</li>
    </ChannelActionsLane>,
  );
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  return r;
}

beforeEach(() => {
  apiFetch.mockReset();
  eventRows.value = [
    { stage: "loaded_context", meta: null },
    { stage: "tool_use_completed", meta: { tool_name: "mcp__server__memory__search" } },
    { stage: "tool_use_started", meta: { tool_name: "mcp__server__web_fetch__get" } },
  ];
  route();
});
afterEach(cleanup);

describe("a run still in flight over a list that already has a card", () => {
  it("says the channel is working, keeps the written card, and leaks no tool name", async () => {
    await mount("running");
    expect(screen.getByText(/Cooking up new suggestions for LinkedIn/)).toBeTruthy();
    expect(screen.queryByTestId("run-steps")).toBeNull();
    expect(screen.queryAllByText("The action the run has written so far").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/mcp__|web_fetch|memory__search/);
  });

  it("shows the header alone when we could not learn which run this is", async () => {
    route({ lastRunId: null });
    await mount("running");
    expect(screen.getByText(/Cooking up new suggestions for LinkedIn/)).toBeTruthy();
    expect(screen.queryByTestId("run-steps")).toBeNull();
  });
});

describe("a settled page is untouched", () => {
  it.each<ChannelDetail["workState"]>(["idle", "delivered", "needs_review"])(
    "draws no progress block (%s)",
    async (workState) => {
      await mount(workState);
      expect(screen.queryByText(/Cooking up new suggestions for/)).toBeNull();
      expect(screen.queryByTestId("run-steps")).toBeNull();
    },
  );

  it("leaves the empty page's own in-flight state to the empty state", async () => {
    route({ actions: [] });
    await mount("running");
    expect(screen.getAllByText(/Cooking up new suggestions for LinkedIn/)).toHaveLength(1);
  });
});

describe("a run pressed here, before the channel payload knows about it", () => {
  it("says it started just now, not when the PREVIOUS run finished", async () => {
    route({ actions: [] });
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    await mount("delivered", fiveDaysAgo);
    await act(async () => {
      screen.getByRole("button", { name: /Get suggestions/ }).click();
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId("empty-running").querySelector("[data-step=current]")?.textContent).toBe("Reading how LinkedIn is doing");
    expect(document.body.textContent).not.toMatch(/\d{3,} min ago/);
  });
});

it("keeps Zavi-owned setup outside the customer checklist", async () => {
  const operator = makeAction("other", { id: "zavi-setup", channel_slug: SLUG, title: "Internal advertiser setup", body: { step: { responsibility: "zavi" } } });
  route({ actions: [operator, card] });
  await mount("idle");
  expect(screen.getByText(/Zavi needs to complete 1 setup check/)).toBeTruthy();
  expect(screen.queryByText("Internal advertiser setup")).toBeNull();
  expect(screen.getByRole("heading", { name: card.title })).toBeTruthy();
});

it("keeps unowned legacy recommendations read-only when the platform requires explicit ownership", async () => {
  const { platformFor } = await import("./platforms");
  const platform = platformFor(SLUG);
  platform.requireActionResponsibility = true;
  try {
    const current = makeAction("other", { id: "current-client", channel_slug: SLUG, title: "Review the current draft", body: { step: { responsibility: "client" } } });
    route({ actions: [card, current] });
    await mount("idle");
    expect(screen.getByText(/Saved recommendations need a refresh/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: card.title })).toBeNull();
    expect(screen.getByText(card.title).closest("details")).toBeTruthy();
    expect(screen.getByRole("heading", { name: current.title })).toBeTruthy();
  } finally { delete platform.requireActionResponsibility; }
});

it("does not claim nothing needs doing when only legacy recommendations were filtered", async () => {
  const { platformFor } = await import("./platforms");
  const platform = platformFor(SLUG);
  platform.requireActionResponsibility = true;
  try {
    route({ actions: [card] });
    await mount("delivered");
    expect(screen.queryByText(/found nothing that needs doing|No pending steps here right now/)).toBeNull();
    expect(screen.getByText(/Saved recommendations need a refresh before/)).toBeTruthy();
  } finally { delete platform.requireActionResponsibility; }
});

it("explains an operator-only result without claiming the channel has no work", async () => {
  route({ actions: [makeAction("other", { body: { step: { responsibility: "zavi" } } })] });
  await mount("delivered");
  expect(screen.queryByText(/found nothing that needs doing|No pending steps here right now/)).toBeNull();
  expect(screen.getByText(/Only Zavi setup checks are listed/)).toBeTruthy();
});

it("draws every customer step of the kind, with no toggle hiding the rest", async () => {
  const { platformFor } = await import("./platforms");
  const platform = platformFor(SLUG);
  platform.requireActionResponsibility = true;
  const customers = Array.from({ length: 7 }, (_, i) => makeAction("other", {
    id: `customer-${i}`, title: `Customer step ${i + 1}`, position: i + 1,
    body: { step: { responsibility: "client" } },
  }));
  const notes = [card, makeAction("other", { id: "operator", body: { step: { responsibility: "zavi" } } })];
  try {
    route();
    const defaultRoute = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string) => {
      if (String(url).includes(`/api/channels/${SLUG}/actions`)) {
        const all = String(url).includes("all=1");
        return ok({ actions: [...(all ? customers : customers.slice(0, 5)), ...notes], more: all ? 0 : 2, store: "channel_actions" });
      }
      return defaultRoute(url);
    });
    await mount("delivered");
    expect(await screen.findByRole("heading", { name: "Customer step 7" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: /Customer step/ })).toHaveLength(7);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Show less$/ })).toBeNull();
  } finally { delete platform.requireActionResponsibility; }
});

it("keeps an executable campaign with missing legacy responsibility visible with its funding facts", async () => {
  const { platformFor } = await import("./platforms");
  const platform = platformFor(SLUG);
  platform.requireActionResponsibility = true;
  try {
    const executable = makeAction("create_ad", { id: "pending-exec", channel_slug: SLUG, title: "Create and launch test campaign", executable: true, card_kind: "executes", primary_label: "Create ad", body: {
      step: { body: "Create at $25/day" },
      exact_change: { rows: [{ item: "Required wallet coverage", before: "", after: "$300.00" }, { item: "Funding shortfall", before: "", after: "$131.18" }] },
    } });
    route({ actions: [executable] });
    await mount("idle");
    expect(screen.getByRole("heading", { name: executable.title })).toBeTruthy();
    expect(screen.getByText("$300.00")).toBeTruthy();
    expect(screen.getByText("$131.18")).toBeTruthy();
    expect(screen.queryByText(/Saved recommendations need a refresh/)).toBeNull();
    expect(screen.getByRole("button", { name: /Create ad/i })).toBeTruthy();
  } finally { delete platform.requireActionResponsibility; }
});
