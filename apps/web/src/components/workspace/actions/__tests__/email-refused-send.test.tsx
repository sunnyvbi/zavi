// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Call = { url: string; method: string };
const calls: Call[] = [];
const server = vi.hoisted(() => ({
  respond: (_url: string, _method: string): { status: number; body: unknown } => ({ status: 200, body: {} }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const a = server.respond(url, method);
    return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) });
  },
}));
const confirm = vi.hoisted(() => ({ fn: vi.fn(async (_o: { title: string }) => true) }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: confirm.fn }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));

import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import type { EmailCardView } from "@/components/email/EmailCampaignCard";
import { makeAction } from "./fixtures";

afterEach(cleanup);

const LEMON = "11111111-1111-4111-8111-111111111111";
const KLAVIYO = "22222222-2222-4222-8222-222222222222";
const email = platformFor("email_marketing");
const REFUSAL = "Email is paused for this workspace, so nothing was sent.";

const view = (id: string, over: Partial<EmailCardView> = {}): EmailCardView => ({
  rail: "channel_actions",
  id,
  class: "bulk_outbound.send",
  status: "pending",
  open: true,
  route: "zavi_list",
  list: { name: "Customers", people: 3 },
  sender: { email: "hello@brightloop.test", name: null },
  reply_to: null,
  unsubscribe_group_id: null,
  viewer_can_approve: true,
  chosen_variant: null,
  versions: [1, 2].map((n) => ({ variant: n, subject: `Lemon tarts are back ${n}`, preview_text: "", html: `<p>${n}</p>`, tested_by_me: true, tested_by_approver: true })),
  can_approve: [true, true],
  reasons: [],
  ...over,
});

const row = (id: string, title: string, over: Record<string, unknown> = {}) =>
  makeAction("send_message", { id, channel_slug: "email_marketing", title, email_card: true, status: "pending", exec_status: null, ...over });

function Pane({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState([row(LEMON, "Lemon tarts are back"), row(KLAVIYO, "Klaviyo welcome")]);
  const handlers = {
    onSetStatus: vi.fn(),
    onRedo: vi.fn(),
    onApprove: vi.fn(),
    onEmailCardChanged: () => {
      onChanged();
      setRows((list) => list.map((r) => (r.id === LEMON ? { ...r, status: "rejected" as const } : r)));
    },
  } satisfies ActionHandlers;
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.id}>
          <ChannelActionCard action={r} platform={email} handlers={handlers} />
        </li>
      ))}
    </ul>
  );
}

describe("a refused Send now on the email channel pane", () => {
  let posted = false;
  beforeEach(() => {
    calls.length = 0;
    posted = false;
    confirm.fn.mockClear();
    confirm.fn.mockResolvedValue(true);
    server.respond = (url, method) => {
      if (url.endsWith("/count")) return { status: 200, body: { people: 3 } };
      if (method === "POST" && url.endsWith("/approve")) {
        posted = true;
        return { status: 409, body: { error: { code: "email_paused", message: REFUSAL } } };
      }
      const id = url.includes(LEMON) ? LEMON : KLAVIYO;
      if (id === LEMON && posted) return { status: 200, body: { card: view(id, { open: false, status: "not_sent", chosen_variant: 1, can_approve: [false, false], failure_reason: REFUSAL }) } };
      return { status: 200, body: { card: view(id) } };
    };
  });

  it("keeps the refused card in place with the refusal inside it, and does not refresh the list under it", async () => {
    const onChanged = vi.fn();
    render(<Pane onChanged={onChanged} />);
    const lemon = await screen.findByTestId(`action-${LEMON}`);
    await waitFor(() => expect(within(lemon).getAllByRole("button", { name: /Approve and send A/ }).length).toBeGreaterThan(0));
    fireEvent.click(within(lemon).getAllByRole("button", { name: /Approve and send A/ })[0]!);
    await waitFor(() => expect(posted).toBe(true));
    await waitFor(() => expect(within(screen.getByTestId(`action-${LEMON}`)).getAllByText(REFUSAL).length).toBeGreaterThan(0));
    const items = screen.getAllByRole("listitem");
    expect(items[0]!.contains(screen.getByTestId(`action-${LEMON}`))).toBe(true);
    expect(within(screen.getByTestId(`action-${LEMON}`)).getAllByText("Not sent").length).toBeGreaterThan(0);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByTestId(`action-${KLAVIYO}`)).toBeTruthy();
  });

  it("a poll that moves the row off 'pending' afterwards still leaves the refused card on screen", async () => {
    const onChanged = vi.fn();
    const { rerender } = render(<Pane onChanged={onChanged} />);
    const lemon = await screen.findByTestId(`action-${LEMON}`);
    await waitFor(() => expect(within(lemon).getAllByRole("button", { name: /Approve and send A/ }).length).toBeGreaterThan(0));
    fireEvent.click(within(lemon).getAllByRole("button", { name: /Approve and send A/ })[0]!);
    await waitFor(() => expect(within(screen.getByTestId(`action-${LEMON}`)).getAllByText(REFUSAL).length).toBeGreaterThan(0));
    rerender(<Pane onChanged={onChanged} />);
    expect(within(screen.getByTestId(`action-${LEMON}`)).getAllByText(REFUSAL).length).toBeGreaterThan(0);
  });
});

describe("Approve answered 401 (the session is gone)", () => {
  beforeEach(() => {
    calls.length = 0;
    confirm.fn.mockClear();
    confirm.fn.mockResolvedValue(true);
    server.respond = (url, method) => {
      if (url.endsWith("/count")) return { status: 200, body: { people: 3 } };
      if (method === "POST" && url.endsWith("/approve")) return { status: 401, body: { error: { code: "unauthenticated", message: "Missing or invalid Bearer token." } } };
      if (calls.some((c) => c.method === "POST")) return { status: 401, body: { error: { code: "unauthenticated", message: "Missing or invalid Bearer token." } } };
      return { status: 200, body: { card: view(LEMON) } };
    };
  });

  it("says the session expired with a reload, shows no backend text, and leaves the test button usable", async () => {
    render(<ChannelActionCard action={row(LEMON, "Lemon tarts are back")} platform={email} handlers={{ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn() }} />);
    const approve = await screen.findAllByRole("button", { name: /Approve and send A/ });
    fireEvent.click(approve[0]!);
    expect(await screen.findByText(/Your session expired\. Reload the page/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload the page" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Bearer|Missing or invalid/);
    expect(screen.queryByText("Not approved")).toBeNull();
    const test = screen.getAllByRole("button", { name: /Send test of A/ })[0] as HTMLButtonElement;
    expect(test.disabled).toBe(false);
  });
});
