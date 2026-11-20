// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CreatorJobDetail } from "@/components/humans/creatorJobTypes";

type Res = { ok: true; data: unknown } | { ok: false; message: string; status: number };
const net = vi.hoisted(() => ({ posts: [] as string[], next: [] as Array<() => Promise<Res>> }));
let served: CreatorJobDetail;

vi.mock("./useCards", () => ({
  callJson: vi.fn(async (path: string, init?: { body?: unknown }): Promise<Res> => {
    if (path.startsWith("/api/humans/orders/o1") && !path.includes("/fulfil") && !init?.body) return { ok: true, data: served };
    if (init?.body && (path.endsWith("/threads") || path.endsWith("/messages"))) {
      net.posts.push(path);
      const step = net.next.shift();
      if (step) return step();
    }
    return { ok: true, data: {} };
  }),
  useCreatorCards: () => ({}),
}));
vi.mock("./PublishCard", () => ({ PublishCard: () => null }));

import { JobDrawer } from "./JobDrawer";

function job(thread_id: string | null): CreatorJobDetail {
  return {
    job: {
      id: "o1",
      source: "booking",
      status: "in_progress",
      closed_reason: null,
      title: "Sales promo",
      creator_display_name: "Maya Films",
      creator_slug: null,
      human_member_id: "m1",
      created_at: "2026-10-01T00:00:00Z",
      due_at: null,
      money: { currency: "usd", price_cents: 15000, business_fee_cents: 1500, business_total_cents: 16500, business_fee_label: "10%", creator_payout_cents: 12750, payout_status: "held" },
      deadline: null,
      awaiting_creator: false,
    },
    package_snapshot: null,
    brief_snapshot: null,
    submissions: [],
    actions: [],
    rebook: null,
    extension: null,
    dispute: null,
    thread: { available: true, thread_id, messages: [] },
  } as unknown as CreatorJobDetail;
}

function deferred() {
  let resolve!: (r: Res) => void;
  const promise = new Promise<Res>((r) => (resolve = r));
  return { promise, resolve };
}

async function type(text: string) {
  const box = (await screen.findByLabelText("Message Maya")) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  return box;
}

beforeEach(() => {
  net.posts.length = 0;
  net.next.length = 0;
  window.history.replaceState(null, "", "/workspace?channel=ugc&drawer=job&job=o1");
});
afterEach(cleanup);

describe("a job drawer message that fails to send says why", () => {
  it("a first message to a creator who is no longer bookable shows the server's reason and keeps the draft, and a later success clears it", async () => {
    served = job(null);
    const first = deferred();
    net.next.push(() => first.promise);
    render(<JobDrawer />);
    const box = await type("Can you film Friday?");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(net.posts).toEqual(["/api/creators/m1/threads"]);
    await act(async () => {
      first.resolve({ ok: false, status: 404, message: "Creator not found." });
      await first.promise;
    });
    expect(screen.getByText("Creator not found.")).toBeTruthy();
    expect(box.value).toBe("Can you film Friday?");

    net.next.push(async () => ({
      ok: true,
      data: { thread: { id: "t9" }, message: { id: "x1", sender_kind: "tenant", body: "Can you film Friday?", created_at: "2026-10-16T10:00:00Z" } },
    }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(net.posts).toEqual(["/api/creators/m1/threads", "/api/creators/m1/threads"]);
    expect(screen.queryByText("Creator not found.")).toBeNull();
    expect(box.value).toBe("");
    expect(screen.getByText("Can you film Friday?")).toBeTruthy();
  });

  it("a reply on an existing thread that fails shows the server's reason and keeps the draft", async () => {
    served = job("t1");
    net.next.push(async () => ({ ok: false, status: 403, message: "Messaging is closed for this job." }));
    render(<JobDrawer />);
    const box = await type("Any update?");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(net.posts).toEqual(["/api/creators/threads/t1/messages"]);
    expect(screen.getByText("Messaging is closed for this job.")).toBeTruthy();
    expect(box.value).toBe("Any update?");
  });
});

describe("the business asks Zavi to step in", () => {
  it("says, before sending, that questions go to the creator and this is for a problem Zavi decides", async () => {
    served = {
      ...job("t1"),
      actions: [{ action: "ask_zavi", label: "Ask Zavi to step in", consequence: "The payout is held until Zavi decides.", wants_note: true }],
    } as unknown as CreatorJobDetail;
    render(<JobDrawer />);
    const more = await screen.findAllByRole("button", { name: /More options|Ask Zavi to step in/ });
    fireEvent.click(more[0]);
    const ask = screen.queryByRole("button", { name: "Ask Zavi to step in" });
    if (ask) fireEvent.click(ask);
    expect((await screen.findByTestId("ask-zavi-hint")).textContent).toContain("For a question about the work, message the creator instead");
  });
});

