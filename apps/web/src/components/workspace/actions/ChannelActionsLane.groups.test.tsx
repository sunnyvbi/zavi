// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
import { makeAction } from "./__tests__/fixtures";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const onTarget = (id: string, title: string, over: Partial<ChannelActionView> = {}, ref = "Spring Sale") =>
  makeAction("fix", {
    id,
    title,
    ...over,
    body: { ...(over.body ?? {}), step: { ...(over.body?.step ?? {}), target: { kind: "campaign", ref } } as never },
  });

let actions: ChannelActionView[] = [];

function route() {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/actions")) return ok({ actions, more: 0, store: "channel_actions" });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({});
  });
}

function lane(slug: string) {
  return render(
    <ChannelActionsLane
      slug={slug}
      legacy={<p>legacy rail</p>}
      workState="idle"
      lastRunAt={null}
      actionCount={0}
      connected
      hasConnectors
    >
      {null}
    </ChannelActionsLane>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  spec.current = { name: "Test Ads" };
});
afterEach(cleanup);

const meta = (index: number, size: number) => `· ${index} of ${size} · Same campaign`;
const cardWithMeta = async (index: number, size: number) => (await screen.findByText(meta(index, size))).closest("article") as HTMLElement;

describe("a group of suggestions for one target", () => {
  it("draws one card per suggestion, each saying its place in the group, named after the target", async () => {
    actions = [
      onTarget("a1", "Raise the budget"),
      makeAction("check", { id: "solo", title: "Fix the pixel" }),
      onTarget("a2", "Swap the headline", {}, "  spring sale "),
    ];
    route();
    lane("groups-tabs");
    const first = await cardWithMeta(1, 2);
    const second = await cardWithMeta(2, 2);
    expect(within(first).getByRole("heading", { name: "Raise the budget" })).toBeTruthy();
    expect(within(second).getByRole("heading", { name: "Swap the headline" })).toBeTruthy();
    expect(within(first).getByTestId("card-footer")).toBeTruthy();
    expect(within(second).getByTestId("card-footer")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    const solo = screen.getByText("Fix the pixel").closest("article") as HTMLElement;
    expect(solo.textContent).not.toContain("Same campaign");
    expect(first.textContent).not.toContain("Fix the pixel");
    expect(second.textContent).not.toContain("Fix the pixel");
  });

  it("does not hide the rest of the kind behind a group", async () => {
    actions = [
      onTarget("g1", "One"),
      onTarget("g2", "Two"),
      onTarget("g3", "Three"),
      ...["s1", "s2"].map((id) => makeAction("fix", { id, title: `Solo ${id}` })),
    ];
    route();
    lane("groups-five");
    await cardWithMeta(1, 3);
    for (const id of ["s1", "s2"]) expect(screen.getByText(`Solo ${id}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("marks the member that blocks the others, and only that one", async () => {
    actions = [onTarget("b1", "Fix tracking first", { blocking: true }), onTarget("b2", "Then raise the budget")];
    route();
    lane("groups-blocking");
    const blocking = (await screen.findByRole("heading", { name: "Fix tracking first" })).closest("article") as HTMLElement;
    const next = (await screen.findByRole("heading", { name: "Then raise the budget" })).closest("article") as HTMLElement;
    expect(within(blocking).getByText("Do this first")).toBeTruthy();
    expect(within(next).queryByText("Do this first")).toBeNull();
  });

  it("draws a plain card, not a group, when only one suggestion is left", async () => {
    actions = [onTarget("o1", "Only one left")];
    route();
    lane("groups-one");
    const card = (await screen.findByText("Only one left")).closest("article") as HTMLElement;
    expect(card.textContent).not.toContain("Same campaign");
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("an executable member shows its exact change before its Approve, on its own card", async () => {
    actions = [
      onTarget("m1", "Swap the headline"),
      onTarget("m2", "Pause the weak ad set", {
        action_type: "pause_ad",
        executable: true,
        body: {
          action_label: "Pause",
          change_sentence: "Zavi pauses one ad set.",
          exact_change: { rows: [{ item: "Ad set Spring 2", before: "Active", after: "Paused" }] },
        },
      }),
    ];
    route();
    lane("groups-money");
    const member = (await screen.findByRole("heading", { name: "Pause the weak ad set" })).closest("article") as HTMLElement;
    const change = await waitFor(() => {
      const el = member.querySelector('[data-testid="exact-change"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(change.textContent).toContain("Ad set Spring 2");
    expect(change.textContent).toContain("Paused");
    const approve = Array.from(member.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Pause");
    expect(approve, "the named change must be a button on its own card").toBeTruthy();
    expect(change.compareDocumentPosition(approve!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const other = (await screen.findByRole("heading", { name: "Swap the headline" })).closest("article") as HTMLElement;
    expect(Array.from(other.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Pause")).toBe(false);
  });
});

describe("grouping sees the whole ranked list", () => {
  it("reads every open action, and every other fix stays on screen beside the group", async () => {
    actions = [
      onTarget("f1", "One"),
      onTarget("f2", "Two"),
      onTarget("f3", "Three"),
      ...["t1", "t2", "t3", "t4", "t5"].map((id) => makeAction("fix", { id, title: `Other ${id}` })),
    ];
    route();
    lane("groups-full-list");
    await cardWithMeta(1, 3);
    const reads = apiFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/actions"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((u) => u.includes("all=1"))).toBe(true);
    for (const id of ["t1", "t2", "t3", "t4", "t5"]) expect(screen.getByText(`Other ${id}`)).toBeTruthy();
  });
});
