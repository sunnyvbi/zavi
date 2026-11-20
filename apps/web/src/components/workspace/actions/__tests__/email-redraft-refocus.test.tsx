// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";

const server = vi.hoisted(() => ({
  listed: [] as string[],
  reads: 0,
  view: (_id: string): unknown => ({}),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string) => {
    const u = String(url);
    let body: unknown = {};
    if (u.includes("/api/channels/email_marketing/actions")) {
      server.reads += 1;
      body = { actions: server.listed.map((id) => row(id)), more: 0, store: "channel_actions" };
    } else if (u.endsWith("/count")) body = { people: 3 };
    else if (u.includes("/api/email-cards/channel_actions/")) {
      const id = u.split("/api/email-cards/channel_actions/")[1]!.split(/[/?]/)[0]!;
      body = { card: server.view(id) };
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: async () => true }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

import { ChannelActionCard } from "../ChannelActionCard";
import { useChannelActions } from "../useChannelActions";
import { platformFor } from "../platforms";
import type { EmailCardView } from "@/components/email/EmailCampaignCard";
import { makeAction } from "./fixtures";

const OLD = "9f1efc8f-287f-4e2a-87e2-0ce89bb78700";
const NEW = "e970e26b-7733-4d43-a05d-1ec2cb1bb208";
const email = platformFor("email_marketing");

function row(id: string) {
  return makeAction("send_message", {
    id,
    channel_slug: "email_marketing",
    title: id === OLD ? "Lemon tarts, this weekend only" : "Fresh lemon tarts, Saturday only",
    email_card: true,
    status: "pending",
    exec_status: null,
  });
}

const view = (id: string): EmailCardView => {
  const subject = id === OLD ? "Lemon tarts, this weekend only" : "Fresh lemon tarts, Saturday only";
  return {
    rail: "channel_actions",
    id,
    class: "bulk_outbound.send",
    status: "pending",
    open: true,
    route: "klaviyo",
    list: { name: "Customers", people: 3 },
    sender: { email: "hello@brightloop.test", name: null },
    reply_to: null,
    unsubscribe_group_id: null,
    viewer_can_approve: true,
    chosen_variant: null,
    versions: [1, 2].map((n) => ({ variant: n, subject: `${subject} ${n}`, preview_text: "", html: `<p>${n}</p>`, tested_by_me: true, tested_by_approver: true })),
    can_approve: [true, true],
    reasons: [],
  };
};

function Lane() {
  const channel = useChannelActions("email_marketing", { all: true });
  return (
    <ul>
      {channel.actions.map((a) => (
        <li key={a.id}>
          <ChannelActionCard action={a} platform={email} handlers={channel.handlers} />
        </li>
      ))}
    </ul>
  );
}

async function showsOldCard() {
  const old = await screen.findByTestId(`action-${OLD}`);
  await waitFor(() => expect(within(old).getAllByRole("button", { name: /Approve and send A/ }).some((b) => !(b as HTMLButtonElement).disabled)).toBe(true));
}

async function showsOnlyNewCard() {
  await waitFor(() => expect(screen.queryByTestId(`action-${OLD}`)).toBeNull());
  const fresh = await screen.findByTestId(`action-${NEW}`);
  await waitFor(() => expect(within(fresh).getAllByText(/Fresh lemon tarts, Saturday only/).length).toBeGreaterThan(0));
  expect(screen.queryAllByText(/Lemon tarts, this weekend only/)).toHaveLength(0);
  const enabledOld = screen.queryAllByRole("button", { name: /Approve and send A/ }).filter((b) => !(b as HTMLButtonElement).disabled && !fresh.contains(b));
  expect(enabledOld).toHaveLength(0);
}

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  server.listed = [OLD];
  server.reads = 0;
  server.view = view;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the email lane after Ask Zavi files a redraft elsewhere", () => {
  it("drops the old card and its live Approve and send A when the window regains focus", async () => {
    render(<Lane />);
    await showsOldCard();
    const before = server.reads;
    server.listed = [NEW];
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(server.reads).toBe(before + 1));
    await showsOnlyNewCard();
  });

  it("drops the old card when the tab becomes visible again", async () => {
    render(<Lane />);
    await showsOldCard();
    const before = server.reads;
    server.listed = [NEW];
    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(server.reads).toBe(before);
    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(server.reads).toBe(before + 1));
    await showsOnlyNewCard();
  });
  it("sends one list read per return to the tab, though focus and visibilitychange both fire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
    render(<Lane />);
    await showsOldCard();
    const before = server.reads;
    server.listed = [NEW];
    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    vi.setSystemTime(new Date("2026-10-29T10:05:00Z"));
    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await showsOnlyNewCard();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.reads).toBe(before + 1);

    vi.setSystemTime(new Date("2026-10-29T10:05:00.400Z"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.reads).toBe(before + 1);

    server.listed = [OLD];
    vi.setSystemTime(new Date("2026-10-29T10:05:01.500Z"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(server.reads).toBe(before + 2));
    await screen.findByTestId(`action-${OLD}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.reads).toBe(before + 2);
  });
});
