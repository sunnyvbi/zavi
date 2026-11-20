// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PlatformSpec } from "./types";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("./platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "./ChannelActionsLane";
import { FIXTURES } from "./__tests__/fixtures";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const check = (key: string, title: string, kind: string): ChannelActionView =>
  ({
    ...FIXTURES.other,
    id: `check:${key}`,
    action_type: "fix",
    title,
    card_kind: kind,
    primary_label: "Verify",
    done_label: "It works",
    body: { step: { title, body: `${title} body.`, effort: "minutes" } },
  }) as ChannelActionView;

const CARD_ONE = check("one", "First check", "task");
const CARD_TWO = check("two", "Second check", "task");

function mount(slug: string) {
  return render(
    <ChannelActionsLane slug={slug} legacy={<p>legacy rail</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors>
      <li>prior row</li>
    </ChannelActionsLane>,
  );
}

function wire(done: (url: string) => Promise<unknown>) {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/checks/")) return done(u);
    if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    if (u.includes("/dashboard")) return ok({ connected: true, drafts: [] });
    return ok({});
  });
}

const doneCalls = () => apiFetch.mock.calls.filter(([u]) => String(u).includes("/checks/")).map(([u]) => String(u));

async function chooseItWorks(title: string) {
  const card = (await screen.findByText(title)).closest("article") as HTMLElement;
  const more = await waitFor(() => within(card).getByRole("button", { name: /more actions/i }));
  fireEvent.click(more);
  fireEvent.click(await screen.findByRole("menuitem", { name: /It works/ }));
}

beforeEach(() => {
  apiFetch.mockReset();
  spec.current = { name: "Made-up channel", kpiFallback: "gads", stagedCards: () => [CARD_ONE, CARD_TWO] };
});
afterEach(cleanup);

const cardOf = async (title: string) => (await screen.findByText(title)).closest("article") as HTMLElement;
const moreOn = (card: HTMLElement) => within(card).queryByRole("button", { name: /more actions/i });
const resolvedOn = async (card: HTMLElement, label: string) => {
  await waitFor(() => expect(within(card).getByRole("status").textContent).toBe(label));
};

describe("It works on a check card", () => {
  it("locks that card before the server answers, writes once, and never touches the next card", async () => {
    let release: (v: unknown) => void = () => {};
    wire(() => new Promise((r) => (release = r)));
    mount("check-optimistic");
    await chooseItWorks("First check");

    const first = await cardOf("First check");
    await waitFor(() => expect(moreOn(first)).toBeNull());
    expect(doneCalls()).toEqual(["/api/channels/check-optimistic/checks/one/done"]);
    expect(screen.queryByRole("menuitem")).toBeNull();
    const second = await cardOf("Second check");
    expect(within(second).getByRole("button", { name: /more actions/i }).getAttribute("aria-expanded")).not.toBe("true");

    release(ok({}));
    await resolvedOn(first, "It works");
    await waitFor(() => expect(doneCalls()).toHaveLength(1));
    expect(doneCalls().some((u) => u.includes("/two/"))).toBe(false);
    expect(moreOn(second)).toBeTruthy();
  });

  it("gives the card its actions back with the reason when the server refuses", async () => {
    let fail: (v: unknown) => void = () => {};
    wire(() => new Promise((r) => (fail = r)));
    mount("check-refused");
    await chooseItWorks("First check");
    await waitFor(() => expect(moreOn(screen.getByText("First check").closest("article") as HTMLElement)).toBeNull());

    fail({ ok: false, status: 503, json: async () => ({}) });
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy());
    const card = screen.getByText("First check").closest("article") as HTMLElement;
    await waitFor(() => expect(within(card).queryByRole("status")).toBeNull());
    expect(moreOn(card)).toBeTruthy();
    expect(doneCalls()).toEqual(["/api/channels/check-refused/checks/one/done"]);
  });
});

describe("It works, after the server answers", () => {
  function server() {
    const state = { has: new Set(["check:one", "check:two"]), hold: null as Promise<void> | null };
    spec.current = {
      name: "Made-up channel",
      kpiFallback: "gads",
      stagedCards: (p) => [CARD_ONE, CARD_TWO].filter((c) => ((p as { has?: string[] } | null)?.has ?? []).includes(c.id)),
    };
    const dashboardReads = () => apiFetch.mock.calls.filter(([u]) => String(u).includes("/dashboard")).length;
    return { state, dashboardReads };
  }

  function wireServer(state: { has: Set<string>; hold: Promise<void> | null }, done: (url: string) => Promise<unknown>) {
    apiFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/checks/")) return done(u);
      if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
      if (u.includes("/metrics")) return ok({ metrics: [] });
      if (u.includes("/dashboard")) {
        if (state.hold) await state.hold;
        return ok({ connected: true, drafts: [], has: [...state.has] });
      }
      return ok({});
    });
  }

  it("keeps the card resolved while the re-read is out, so it can not be pressed a second time", async () => {
    const { state, dashboardReads } = server();
    let release: (v: unknown) => void = () => {};
    wireServer(state, () => new Promise((r) => (release = r)));
    mount("check-no-flicker");
    await chooseItWorks("First check");
    await waitFor(() => expect(moreOn(screen.getByText("First check").closest("article") as HTMLElement)).toBeNull());

    let openRead: () => void = () => {};
    state.hold = new Promise<void>((r) => (openRead = r));
    const readsBefore = dashboardReads();
    release(ok({}));
    await waitFor(() => expect(dashboardReads()).toBeGreaterThan(readsBefore));
    await new Promise((r) => setTimeout(r, 30));

    await resolvedOn(await cardOf("First check"), "It works");
    expect(moreOn(await cardOf("First check"))).toBeNull();
    expect(doneCalls()).toEqual(["/api/channels/check-no-flicker/checks/one/done"]);

    state.has = new Set(["check:two"]);
    state.hold = null;
    openRead();
    await new Promise((r) => setTimeout(r, 30));
    await resolvedOn(await cardOf("First check"), "It works");
    expect(moreOn(await cardOf("Second check"))).toBeTruthy();
    expect(doneCalls()).toHaveLength(1);

    state.has = new Set(["check:one", "check:two"]);
    await chooseItWorks("Second check");
    release(ok({}));
    await resolvedOn(await cardOf("Second check"), "It works");
    expect(doneCalls()).toEqual([
      "/api/channels/check-no-flicker/checks/one/done",
      "/api/channels/check-no-flicker/checks/two/done",
    ]);
  });

  it("gives the card its actions back on a refused save, with the first read still holding it", async () => {
    const { state } = server();
    let refuse: (v: unknown) => void = () => {};
    wireServer(state, () => new Promise((r) => (refuse = r)));
    mount("check-refused-held");
    await chooseItWorks("First check");
    await waitFor(() => expect(moreOn(screen.getByText("First check").closest("article") as HTMLElement)).toBeNull());
    refuse({ ok: false, status: 500, json: async () => ({}) });
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy());
    const card = screen.getByText("First check").closest("article") as HTMLElement;
    await waitFor(() => expect(within(card).queryByRole("status")).toBeNull());
    expect(moreOn(card)).toBeTruthy();
    expect(doneCalls()).toEqual(["/api/channels/check-refused-held/checks/one/done"]);
  });

  it("offers a check again when the server brings it back after it left", async () => {
    const { state } = server();
    wireServer(state, async () => {
      if (state.has.has("check:one")) state.has = new Set(["check:two"]);
      else state.has = new Set(["check:one"]);
      return ok({});
    });
    mount("check-comes-back");
    await chooseItWorks("First check");
    await resolvedOn(await cardOf("First check"), "It works");
    await waitFor(() => expect(screen.getByText("Second check")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 30));
    await resolvedOn(await cardOf("First check"), "It works");

    await chooseItWorks("Second check");
    await resolvedOn(await cardOf("Second check"), "It works");
    await waitFor(() => expect(moreOn(screen.getByText("First check").closest("article") as HTMLElement)).toBeTruthy());
    expect(doneCalls()).toEqual([
      "/api/channels/check-comes-back/checks/one/done",
      "/api/channels/check-comes-back/checks/two/done",
    ]);
  });
});
