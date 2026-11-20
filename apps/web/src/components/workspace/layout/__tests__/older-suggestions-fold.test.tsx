// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("next/font/local", () => ({ default: () => ({ className: "", style: {} }) }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const { spec } = vi.hoisted(() => ({ spec: { current: { name: "Test" } as PlatformSpec } }));
vi.mock("../../actions/platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../actions/platforms")>()),
  platformFor: () => spec.current,
}));

import type { PlatformSpec } from "../../actions/types";
import { makeAction } from "../../actions/__tests__/fixtures";

import { ChannelActionsLane, PriorItemsFold } from "../../actions/ChannelActionsLane";
import { chatStagedItemsOf, priorItemsOf } from "../ChannelsPanel";

afterEach(cleanup);

describe("priorItemsOf", () => {
  it("leaves out every channel_actions row, keeps decisions and unlabelled rows", () => {
    const rows = [
      { id: "live", action_source: "channel_action" as const },
      { id: "old", action_source: "decision" as const },
      { id: "older-server" },
    ];
    expect(priorItemsOf(rows).map((r) => r.id)).toEqual(["old", "older-server"]);
  });

  it("a chat-staged row (decision with a thread) is live, not older", () => {
    const rows = [
      { id: "chat", action_source: "decision" as const, thread_id: "t-1" },
      { id: "old", action_source: "decision" as const, thread_id: null },
      { id: "live", action_source: "channel_action" as const, thread_id: "t-1" },
    ];
    expect(priorItemsOf(rows).map((r) => r.id)).toEqual(["old"]);
    expect(chatStagedItemsOf(rows).map((r) => r.id)).toEqual(["chat"]);
  });
});

describe("the Older suggestions fold", () => {
  it("is titled and explained in plain words", () => {
    render(
      <PriorItemsFold count={2}>
        <li>row one</li>
        <li>row two</li>
      </PriorItemsFold>,
    );
    const fold = screen.getByTestId("prior-items");
    expect(fold.querySelector("summary")?.textContent).toBe("Older suggestions (2)");
    expect(fold.textContent).toContain(
      "Written before Zavi re-checked this channel. The numbers behind them are out of date, so they are read-only here. Run the channel again for fresh ones.",
    );
    expect(fold.textContent).not.toContain("approvals list");
  });

  it("is hidden when there are no older suggestions", () => {
    render(<PriorItemsFold count={priorItemsOf([{ action_source: "channel_action" as const }]).length}>{null}</PriorItemsFold>);
    expect(screen.queryByTestId("prior-items")).toBeNull();
  });
});

describe("the lane's fold", () => {
  it("holds the rows the panel hands it as `prior`, not the whole approvals list", async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    apiFetch.mockImplementation(async (url: string) =>
      String(url).includes("/actions") ? ok({ actions: [], more: 0, store: "channel_actions" }) : ok({ metrics: [] }),
    );
    render(
      <ChannelActionsLane
        slug="fold-prior"
        legacy={<p>legacy rail</p>}
        workState="idle"
        lastRunAt={null}
        actionCount={3}
        connected
        hasConnectors
        prior={{
          ids: ["d-old"],
          render: (ids) => (ids.includes("d-old") ? <li>OLD DECISION ROW</li> : null),
        }}
      >
        <li>LIVE CARD AGAIN</li>
      </ChannelActionsLane>,
    );
    const fold = await screen.findByTestId("prior-items");
    expect(fold.querySelector("summary")?.textContent).toBe("Older suggestions (1)");
    expect(fold.textContent).toContain("OLD DECISION ROW");
    expect(fold.textContent).not.toContain("LIVE CARD AGAIN");
  });

  it("leaves out a staged draft the lane already draws live, even though it is a decision row", async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    apiFetch.mockImplementation(async (url: string) =>
      String(url).includes("/actions") ? ok({ actions: [], more: 0, store: "channel_actions" }) : ok({ metrics: [] }),
    );
    spec.current = {
      name: "Test",
      stagedCards: () => [makeAction("text_post", { id: "d-staged", title: "STAGED DRAFT LIVE" })],
    } as PlatformSpec;
    const rendered: string[][] = [];
    render(
      <ChannelActionsLane
        slug="fold-staged"
        legacy={<p>legacy rail</p>}
        workState="idle"
        lastRunAt={null}
        actionCount={2}
        connected
        hasConnectors
        prior={{
          ids: ["d-staged", "d-old"],
          render: (ids) => {
            rendered.push([...ids]);
            return ids.map((id) => <li key={id}>ROW {id}</li>);
          },
        }}
      >
        {null}
      </ChannelActionsLane>,
    );
    expect((await screen.findAllByText("STAGED DRAFT LIVE")).length).toBeGreaterThan(0);
    const fold = screen.getByTestId("prior-items");
    expect(fold.querySelector("summary")?.textContent).toBe("Older suggestions (1)");
    expect(fold.textContent).toContain("ROW d-old");
    expect(fold.textContent).not.toContain("ROW d-staged");
    expect(rendered.at(-1)).toEqual(["d-old"]);
    spec.current = { name: "Test" } as PlatformSpec;
  });

  it("draws chat-staged rows ENABLED above the fold, never inside it", async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    apiFetch.mockImplementation(async (url: string) =>
      String(url).includes("/actions") ? ok({ actions: [], more: 0, store: "channel_actions" }) : ok({ metrics: [] }),
    );
    render(
      <ChannelActionsLane
        slug="fold-chat"
        legacy={<p>legacy rail</p>}
        workState="idle"
        lastRunAt={null}
        actionCount={2}
        connected
        hasConnectors
        prior={{ ids: ["d-old"], render: () => <li>OLD ROW</li> }}
        chatStaged={{
          ids: ["d-chat"],
          render: (ids) => ids.map((id) => (
            <li key={id}>
              CHAT ROW <button type="button">Approve</button>
            </li>
          )),
        }}
      >
        {null}
      </ChannelActionsLane>,
    );
    const live = await screen.findByTestId("chat-staged");
    expect(live.textContent).toContain("CHAT ROW");
    expect(live.tagName).toBe("UL");
    expect(live.querySelector("button")?.matches("fieldset[disabled] *")).toBe(false);
    const fold = screen.getByTestId("prior-items");
    expect(fold.textContent).not.toContain("CHAT ROW");
    expect(fold.textContent).toContain("OLD ROW");
  });
  it("an empty delivered queue points at live steps below instead of saying none are pending", async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    apiFetch.mockImplementation(async (url: string) =>
      String(url).includes("/actions") ? ok({ actions: [], more: 0, store: "channel_actions" }) : ok({ metrics: [] }),
    );
    render(
      <ChannelActionsLane
        slug="fold-chat-empty"
        legacy={<p>legacy rail</p>}
        workState="delivered"
        lastRunAt={null}
        actionCount={1}
        connected
        hasConnectors
        chatStaged={{ ids: ["d-chat"], render: (ids) => ids.map((id) => <li key={id}>CHAT ROW</li>) }}
      >
        {null}
      </ChannelActionsLane>,
    );
    await screen.findByTestId("chat-staged");
    expect(await screen.findByText("Pending steps are listed below.")).toBeTruthy();
    expect(screen.queryByText("No pending steps here right now.")).toBeNull();
  });
});
