// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PlatformSpec } from "./types";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
const approveDecision = vi.hoisted(() => vi.fn());
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("./platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "./ChannelActionsLane";
import { FIXTURES, makeAction } from "./__tests__/fixtures";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = { ok: false, status: 500, json: async () => ({ error: { message: "The server said no." } }) };

const CARD_A: ChannelActionView = { ...FIXTURES.other, id: "act-a", title: "Audience review A" };
const CARD_B: ChannelActionView = makeAction("fix", { id: "act-b", title: "Budget review B", body: { step: { title: "Budget review B", body: "Body B." } } });

function mount(slug: string) {
  return render(
    <ChannelActionsLane slug={slug} legacy={<p>legacy rail</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors>
      <li>prior row</li>
    </ChannelActionsLane>,
  );
}

function wire(opts: { actions: ChannelActionView[]; write: (url: string) => Promise<unknown>; staged?: boolean }) {
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (init?.method === "POST" && (u.includes("/api/channel-actions/") || u.includes("/api/approvals/"))) return opts.write(u);
    if (u.includes("/actions")) return ok({ actions: opts.actions, more: 0, store: "channel_actions" });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    if (u.includes("/dashboard")) return ok({ connected: true, drafts: [] });
    return ok({});
  });
}

const writes = () => apiFetch.mock.calls.filter(([u, i]) => i?.method === "POST" && /\/api\/(channel-actions|approvals)\//.test(String(u))).map(([u]) => String(u));

async function closeCard(title: string) {
  const card = (await screen.findByText(title)).closest("article") as HTMLElement;
  fireEvent.click(await waitFor(() => within(card).getByRole("button", { name: /^Close “/ })));
}

async function notNowOneWeek(text: string) {
  const card = (await screen.findByText(text)).closest("article") as HTMLElement;
  fireEvent.click(await waitFor(() => within(card).getByRole("button", { name: /more actions/i })));
  fireEvent.click(await screen.findByRole("menuitem", { name: /Not now/ }));
  fireEvent.click(await within(card).findByRole("button", { name: "1 week" }));
}

beforeEach(() => {
  apiFetch.mockReset();
  approveDecision.mockReset();
  spec.current = { name: "Made-up channel", kpiFallback: "gads" };
});
afterEach(cleanup);

const cardOf = async (text: string) => (await screen.findByText(text)).closest("article") as HTMLElement;
const moreOn = (card: HTMLElement) => within(card).queryByRole("button", { name: /more actions/i });
const resolvedOn = async (card: HTMLElement, label: string) => {
  await waitFor(() => expect(within(card).getByRole("status").textContent).toBe(label));
};

describe("a verb on a regular card", () => {
  it("locks that card before the request resolves, writes once, and leaves the other card alone", async () => {
    let release: (v: unknown) => void = () => {};
    wire({ actions: [CARD_A, CARD_B], write: () => new Promise((r) => (release = r)) });
    mount("verb-snooze");
    await notNowOneWeek("Audience review A");

    const cardA = await cardOf("Audience review A");
    await waitFor(() => expect(moreOn(cardA)).toBeNull());
    expect(writes()).toEqual(["/api/channel-actions/act-a"]);
    expect(JSON.parse(apiFetch.mock.calls.find(([u, i]) => i?.method === "POST" && String(u).includes("/api/channel-actions/"))![1].body).action).toBe("snoozed");
    expect(screen.queryByRole("menuitem")).toBeNull();
    const cardB = await cardOf("Budget review B");
    expect(moreOn(cardB)).toBeTruthy();

    release(ok({}));
    await resolvedOn(cardA, "Not now");
    await waitFor(() => expect(screen.getByText(/Hidden for now/)).toBeTruthy());
    expect(writes()).toEqual(["/api/channel-actions/act-a"]);
    expect(moreOn(cardB)).toBeTruthy();
    expect(within(cardB).queryByRole("status")).toBeNull();
  });

  it("keeps the resolved label when a refetch still returns the card, and sends the rejection", async () => {
    let release: (v: unknown) => void = () => {};
    wire({ actions: [CARD_A, CARD_B], write: () => new Promise((r) => (release = r)) });
    mount("verb-reject");
    await closeCard("Audience review A");
    const cardA = await cardOf("Audience review A");
    await waitFor(() => expect(moreOn(cardA)).toBeNull());
    release(ok({}));
    await resolvedOn(cardA, "Closed");
    await new Promise((r) => setTimeout(r, 50));
    await resolvedOn(await cardOf("Audience review A"), "Closed");
    expect(moreOn(await cardOf("Audience review A"))).toBeNull();
    expect(writes()).toEqual(["/api/channel-actions/act-a"]);
    const body = JSON.parse(apiFetch.mock.calls.find(([u, i]) => i?.method === "POST" && String(u).includes("/api/channel-actions/"))![1].body);
    expect(body.action).toBe("rejected");
    expect(body.note).toBeUndefined();
    expect(screen.queryByText(/Zavi reads your reason/)).toBeNull();
  });

  it("gives the card its actions back with the existing notice when the server refuses", async () => {
    let refuse: (v: unknown) => void = () => {};
    wire({ actions: [CARD_A, CARD_B], write: () => new Promise((r) => (refuse = r)) });
    mount("verb-refused");
    await notNowOneWeek("Audience review A");
    const cardA = await cardOf("Audience review A");
    await waitFor(() => expect(moreOn(cardA)).toBeNull());
    refuse(fail);
    await waitFor(() => expect(moreOn(screen.getByText("Audience review A").closest("article") as HTMLElement)).toBeTruthy());
    expect(within(screen.getByText("Audience review A").closest("article") as HTMLElement).queryByRole("status")).toBeNull();
    expect(screen.getByText("Zavi could not save that. Try again.")).toBeTruthy();
  });
});

describe("a verb on a staged card", () => {
  const STAGED: ChannelActionView = { ...FIXTURES.other, id: "decision-1", action_type: "text_post", title: "Staged post", body: { step: { deliverable: { kind: "post", label: "Post", content: "Staged copy here." } } } };

  const pressDone = async (card: HTMLElement) => {
    fireEvent.click(await waitFor(() => within(card).getByRole("button", { name: /more actions/i })));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Done/ }));
  };

  it("resolves the card after the approvals request, and gives it back on failure", async () => {
    let settle: (v: unknown) => void = () => {};
    wire({ actions: [], write: () => new Promise((r) => (settle = r)) });
    spec.current = { name: "Made-up channel", kpiFallback: "gads", stagedCards: () => [STAGED] };
    mount("staged-verb");
    await pressDone(await cardOf("Staged copy here."));
    await waitFor(() => expect(writes()).toEqual(["/api/approvals/decision-1/reject"]));
    await waitFor(() => expect(moreOn(screen.getByText("Staged copy here.").closest("article") as HTMLElement)).toBeNull());
    settle(fail);
    await waitFor(() => expect(screen.getByText("The server said no.")).toBeTruthy());
    const card = screen.getByText("Staged copy here.").closest("article") as HTMLElement;
    await waitFor(() => expect(within(card).queryByRole("status")).toBeNull());
    expect(moreOn(card)).toBeTruthy();
    expect(writes()).toEqual(["/api/approvals/decision-1/reject"]);
  });

  const twoStaged = () => {
    const OTHER: ChannelActionView = { ...STAGED, id: "decision-2", title: "Other staged", body: { step: { deliverable: { kind: "post", label: "Post", content: "Other copy here." } } } };
    let has = ["decision-1", "decision-2"];
    apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      if (init?.method === "POST" && u.includes("/api/approvals/")) {
        has = u.includes("decision-1") ? ["decision-2"] : ["decision-1"];
        return ok({});
      }
      if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
      if (u.includes("/metrics")) return ok({ metrics: [] });
      if (u.includes("/dashboard")) return ok({ connected: true, drafts: [], has: [...has] });
      return ok({});
    });
    spec.current = {
      name: "Made-up channel",
      kpiFallback: "gads",
      stagedCards: (p) => [STAGED, OTHER].filter((c) => ((p as { has?: string[] } | null)?.has ?? []).includes(c.id)),
    };
  };

  it("resolves a snoozed staged card and leaves the other staged card open", async () => {
    twoStaged();
    mount("staged-snoozed");
    await notNowOneWeek("Staged copy here.");
    await waitFor(() => expect(screen.getByText(/Hidden for now/)).toBeTruthy());
    await resolvedOn(await cardOf("Staged copy here."), "Not now");
    expect(moreOn(await cardOf("Other copy here."))).toBeTruthy();
    expect(writes()).toEqual(["/api/approvals/decision-1/snooze"]);
  });

  it("offers a snoozed staged card again when the server returns it after it left", async () => {
    twoStaged();
    mount("staged-comes-back");
    await notNowOneWeek("Staged copy here.");
    await resolvedOn(await cardOf("Staged copy here."), "Not now");

    await notNowOneWeek("Other copy here.");
    await resolvedOn(await cardOf("Other copy here."), "Not now");
    await waitFor(() => expect(moreOn(screen.getByText("Staged copy here.").closest("article") as HTMLElement)).toBeTruthy());
    expect(writes()).toEqual(["/api/approvals/decision-1/snooze", "/api/approvals/decision-2/snooze"]);
  });
});
