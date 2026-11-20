// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { ComponentProps } from "react";
import { ThreadFeed } from "./ThreadFeed";

const apiFetch = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts?: unknown) => apiFetch(path, opts),
}));

vi.mock("@/components/email/EmailCampaignCard", () => ({
  EmailCampaignCard: ({ id, onApproved, onRejected, onSettled }: { id: string; onApproved?: () => void; onRejected?: () => void; onSettled?: () => void }) => (
    <div data-testid={`email-card-${id}`}>
      <button type="button" onClick={() => onApproved?.()}>Approve email {id}</button>
      <button type="button" onClick={() => onRejected?.()}>Reject email {id}</button>
      {onSettled && <button type="button" onClick={() => onSettled()}>Settle email {id}</button>}
    </div>
  ),
}));

const tenant = vi.hoisted(() => ({ id: "t-1" as string | null | undefined, clearers: [] as Array<() => void> }));
vi.mock("./brain/useActiveTenant", () => ({ useActiveTenant: () => tenant.id }));
vi.mock("@/lib/workspace/sessionScopedCache", () => ({ registerSessionScopedCache: (clear: () => void) => void tenant.clearers.push(clear) }));

vi.mock("./AgentAvatar", () => ({
  AgentAvatar: ({ slug }: { slug: string }) => <span data-agent={slug} />,
}));

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, clone() { return this; } };
}

function thread(partial: Record<string, unknown> = {}) {
  return {
    id: "t1",
    title: "Build failure",
    created_at: "2026-07-18T09:00:00.000Z",
    last_message_at: "2026-07-18T10:00:00.000Z",
    last_message: "pushed the fix",
    run_status: "success",
    pending: false,
    reply_count: 2,
    first_user_message: "the build is red on main",
    presentation_status: "answered",
    ...partial,
  };
}

function routes(opts: {
  threads?: unknown;
  next_before?: string | null;
  decisions?: unknown[];
  threadsFail?: string;
}) {
  return (path: string) => {
    if (path.startsWith("/api/approvals")) {
      return Promise.resolve(ok({ decisions: opts.decisions ?? [] }));
    }
    if (opts.threadsFail) {
      return Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: opts.threadsFail } }),
        clone() { return this; },
      });
    }
    return Promise.resolve(
      ok({ threads: opts.threads ?? [], next_before: opts.next_before ?? null }),
    );
  };
}

beforeEach(() => {
  apiFetch.mockReset();
  window.sessionStorage.clear();
  tenant.id = "t-1";
  tenant.clearers.length = 0;
});
afterEach(() => {
  cleanup();
});

function mount(
  props: Partial<ComponentProps<typeof ThreadFeed>> = {},
) {
  return render(
    <ThreadFeed
      agentSlug="engineer"
      agentName="Engineer"
      onOpenThread={() => {}}
      {...props}
    />,
  );
}

describe("ThreadFeed — states", () => {
  it("reads the feed endpoint (not the switcher endpoint)", async () => {
    apiFetch.mockImplementation(routes({ threads: [thread()] }));
    mount();
    await waitFor(() => expect(screen.getByText(/the build is red/)).toBeTruthy());
    const paths = apiFetch.mock.calls.map((c) => c[0] as string);
    expect(paths.some((p) => p.includes("/threads-feed?"))).toBe(true);
    expect(paths.some((p) => /\/threads\?/.test(p))).toBe(false);
  });

  it("shows a loading state before the first page lands", () => {
    apiFetch.mockImplementation(() => new Promise(() => {}));
    mount();
    expect(screen.getByText(/loading conversations/i)).toBeTruthy();
  });

  it("shows an empty state when there is genuinely no history", async () => {
    apiFetch.mockImplementation(routes({ threads: [] }));
    mount();
    await waitFor(() =>
      expect(screen.getByText(/no conversations with Engineer yet/i)).toBeTruthy(),
    );
  });

  it("shows an ERROR state — never the empty state — when the read fails", async () => {
    apiFetch.mockImplementation(routes({ threadsFail: "boom" }));
    mount();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/couldn't load your conversations/i)).toBeTruthy();
    expect(screen.queryByText(/no conversations with Engineer yet/i)).toBeNull();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("marks the feed up as a list and separates date groups", async () => {
    apiFetch.mockImplementation(
      routes({
        threads: [
          thread({ id: "a", created_at: "2026-07-18T09:00:00.000Z" }),
          thread({ id: "b", created_at: "2026-07-16T09:00:00.000Z" }),
        ],
      }),
    );
    mount();
    await waitFor(() => expect(screen.getAllByRole("list").length).toBe(2));
    expect(screen.getAllByRole("separator").length).toBe(2);
    expect(screen.getAllByRole("listitem").length).toBe(2);
  });

  it("never renders View trace anywhere in the feed", async () => {
    apiFetch.mockImplementation(
      routes({ threads: [thread({ presentation_status: "running" })] }),
    );
    const { container } = mount();
    await waitFor(() => expect(screen.getByText(/is working/)).toBeTruthy());
    expect(container.textContent ?? "").not.toMatch(/view trace/i);
  });

  it("offers load-more only while the server hands back a cursor", async () => {
    apiFetch.mockImplementation(
      routes({ threads: [thread()], next_before: "2026-07-18T09:00:00.000Z" }),
    );
    mount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /load older/i })).toBeTruthy(),
    );
  });

  it("renders newest LAST — the server's newest-first page read bottom-up", async () => {
    apiFetch.mockImplementation(
      routes({
        threads: [
          thread({ id: "new", first_user_message: "newest thread", created_at: "2026-07-18T09:00:00.000Z" }),
          thread({ id: "mid", first_user_message: "middle thread", created_at: "2026-07-17T09:00:00.000Z" }),
          thread({ id: "old", first_user_message: "oldest thread", created_at: "2026-07-16T09:00:00.000Z" }),
        ],
      }),
    );
    const { container } = mount();
    await waitFor(() => expect(screen.getByText(/newest thread/)).toBeTruthy());
    const text = container.textContent ?? "";
    expect(text.indexOf("oldest thread")).toBeLessThan(text.indexOf("middle thread"));
    expect(text.indexOf("middle thread")).toBeLessThan(text.indexOf("newest thread"));
  });

  it("puts 'Load older' ABOVE the rows, because older is up", async () => {
    apiFetch.mockImplementation(
      routes({ threads: [thread()], next_before: "2026-07-18T09:00:00.000Z" }),
    );
    const { container } = mount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /load older/i })).toBeTruthy(),
    );
    const text = container.textContent ?? "";
    expect(text.indexOf("Load older")).toBeLessThan(text.indexOf("the build is red"));
  });
});

describe("ThreadFeed — approval cards stay at feed level (#1996)", () => {
  const informational = {
    id: "dec-1",
    decision_class: "pm.needs_action",
    handler: null,
    body: {},
    status: "proposed",
    agent_slug: "engineer",
  };

  it("renders a pending approval in the FEED, below the threads", async () => {
    apiFetch.mockImplementation(
      routes({ threads: [thread()], decisions: [informational] }),
    );
    const { container } = mount();
    await waitFor(() => expect(screen.getByText(/needs your yes/i)).toBeTruthy());
    const text = container.textContent ?? "";
    expect(text.indexOf("the build is red")).toBeLessThan(
      text.search(/needs your yes/i),
    );
  });

  it("filters to this agent's proposed decisions only", async () => {
    apiFetch.mockImplementation(
      routes({
        threads: [],
        decisions: [
          { ...informational, id: "other-agent", agent_slug: "growth-lead" },
          { ...informational, id: "already-acted", status: "acted" },
        ],
      }),
    );
    mount();
    await waitFor(() =>
      expect(screen.getByText(/no conversations with Engineer yet/i)).toBeTruthy(),
    );
    expect(screen.queryByText(/needs your yes/i)).toBeNull();
  });

  it("never shows a Composio write card: it lives only in the chat that proposed it", async () => {
    apiFetch.mockImplementation(
      routes({
        threads: [],
        decisions: [
          { ...informational, id: "cmp-1", decision_class: "composio.moves_money", handler: "composio.execute_tool", body: { app_name: "Square", labels: ["moves_money"] } },
          { ...informational, id: "cmp-2", decision_class: "composio.write", handler: null },
        ],
      }),
    );
    mount();
    await waitFor(() =>
      expect(screen.getByText(/no conversations with Engineer yet/i)).toBeTruthy(),
    );
    expect(screen.queryByText(/needs your yes/i)).toBeNull();
    expect(screen.queryByText(/Square/)).toBeNull();
  });

  it("keeps a charge card (approved here from its full card), unlike a Composio write", async () => {
    apiFetch.mockImplementation(
      routes({
        threads: [],
        decisions: [
          { ...informational, id: "pay-1", decision_class: "stripe.create_payment", handler: "stripe.create_payment", body: { governed_by: "chokepoint", amount: 1999, currency: "usd", application_fee_amount: 100, client_reference: "order-7" } },
        ],
      }),
    );
    mount();
    await waitFor(() => expect(screen.getByRole("region", { name: /charge|payment|stripe|pay/i })).toBeTruthy());
  });

  it("Approve POSTs the SHARED /api/approvals/:id/approve endpoint", async () => {
    apiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === "/api/approvals/dec-1/approve" && opts?.method === "POST") {
        return Promise.resolve(ok({}));
      }
      return routes({ threads: [], decisions: [informational] })(path);
    });
    mount();
    await waitFor(() => expect(screen.getByText(/needs your yes/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => {
      const approve = apiFetch.mock.calls.find(
        (c) => (c[0] as string) === "/api/approvals/dec-1/approve",
      );
      expect(approve).toBeTruthy();
      expect((approve?.[1] as { method?: string })?.method).toBe("POST");
    });

    const paths = apiFetch.mock.calls.map((c) => c[0] as string);
    expect(paths.some((p) => /dispatch|\/run\b/.test(p))).toBe(false);
  });

  it("opens Needs you focused on this decision", async () => {
    const onReviewDecision = vi.fn();
    apiFetch.mockImplementation(
      routes({ threads: [], decisions: [informational] }),
    );
    mount({ onReviewDecision });
    await waitFor(() => expect(screen.getByText(/needs your yes/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /open in needs you/i }));

    expect(onReviewDecision).toHaveBeenCalledWith("dec-1");
    expect(screen.queryByText(/open in inbox/i)).toBeNull();
  });

  it("removes a card after its shared approve endpoint succeeds", async () => {
    apiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === "/api/approvals/dec-1/approve" && opts?.method === "POST") {
        return Promise.resolve(ok({}));
      }
      return routes({ threads: [], decisions: [informational] })(path);
    });
    mount();
    await waitFor(() => expect(screen.getByText(/needs your yes/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));

    await waitFor(() => expect(screen.queryByText(/needs your yes/i)).toBeNull());
  });

  it("refetches decisions when a keep-alive agent tab becomes active", async () => {
    apiFetch.mockImplementation(routes({ threads: [], decisions: [] }));
    const mounted = mount({ isActive: false });
    await waitFor(() =>
      expect(screen.getByText(/no conversations with Engineer yet/i)).toBeTruthy(),
    );
    expect(
      apiFetch.mock.calls.filter((call) => call[0] === "/api/approvals"),
    ).toHaveLength(0);

    mounted.rerender(
      <ThreadFeed
        agentSlug="engineer"
        agentName="Engineer"
        isActive
        onOpenThread={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        apiFetch.mock.calls.filter((call) => call[0] === "/api/approvals"),
      ).toHaveLength(1),
    );
  });

  it("a failed approvals read does not blank the feed", async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/api/approvals")) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), clone() { return this; } });
      }
      return routes({ threads: [thread()] })(path);
    });
    mount();
    await waitFor(() => expect(screen.getByText(/the build is red/)).toBeTruthy());
  });
});

describe("ThreadFeed — an approved card never sits in 'waiting on you'", () => {
  const WAITING = '[aria-label="Approvals waiting on you for Engineer"]';
  const FOLLOWING = '[aria-label="Following for Engineer"]';
  const informational = {
    id: "dec-1",
    decision_class: "pm.needs_action",
    handler: null,
    body: {},
    status: "proposed",
    agent_slug: "engineer",
  };
  const email = {
    id: "dec-email",
    decision_class: "email_campaign.create_and_send",
    handler: "email_campaign.create_and_send",
    body: {},
    status: "proposed",
    agent_slug: "engineer",
  };
  const bulk = { ...email, id: "dec-bulk", decision_class: "bulk_outbound.send", handler: "bulk_outbound.send" };

  function approveRoutes(decisions: unknown[]) {
    return (path: string, opts?: { method?: string }) => {
      if (/^\/api\/approvals\/[^/]+\/(approve|reject)$/.test(path) && opts?.method === "POST") {
        return Promise.resolve(ok({}));
      }
      return routes({ threads: [thread()], decisions })(path);
    };
  }

  it("an approved non-email card leaves the waiting region while a pending email card stays in it", async () => {
    apiFetch.mockImplementation(approveRoutes([informational, email]));
    const { container } = mount();
    await waitFor(() => expect(screen.getByText(/needs your yes/i)).toBeTruthy());
    expect(container.querySelector(WAITING)?.querySelector('[data-testid="email-card-dec-email"]')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));

    await waitFor(() => expect(screen.queryByText(/needs your yes/i)).toBeNull());
    const waiting = container.querySelector(WAITING);
    expect(waiting).toBeTruthy();
    expect(waiting?.textContent ?? "").not.toMatch(/approved/i);
    expect(container.querySelector('[data-decision-id="dec-1"]')).toBeNull();
    expect(container.querySelector(FOLLOWING)).toBeNull();
    expect(waiting?.querySelector('[data-testid="email-card-dec-email"]')).toBeTruthy();
  });

  it("removes the waiting region entirely once its only non-email card is approved", async () => {
    apiFetch.mockImplementation(approveRoutes([informational]));
    const { container } = mount();
    await waitFor(() => expect(screen.getByText(/needs your yes/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));

    await waitFor(() => expect(container.querySelector(WAITING)).toBeNull());
    expect(container.textContent ?? "").not.toMatch(/approved/i);
  });

  it("an approved email card stays visible under Following, outside the waiting region", async () => {
    apiFetch.mockImplementation(approveRoutes([email, bulk, informational]));
    const { container } = mount();
    await waitFor(() => expect(screen.getByTestId("email-card-dec-email")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Approve email dec-email" }));

    await waitFor(() => expect(container.querySelector(FOLLOWING)).toBeTruthy());
    const following = container.querySelector(FOLLOWING)!;
    const waiting = container.querySelector(WAITING)!;
    expect(following.getAttribute("role")).toBe("region");
    expect(following.textContent).toMatch(/following/i);
    expect(following.querySelector('[data-testid="email-card-dec-email"]')).toBeTruthy();
    expect(waiting.querySelector('[data-testid="email-card-dec-email"]')).toBeNull();
    expect(waiting.contains(following)).toBe(false);
    expect(container.querySelectorAll('[data-testid="email-card-dec-email"]')).toHaveLength(1);
    expect(waiting.querySelector('[data-testid="email-card-dec-bulk"]')).toBeTruthy();
    expect(waiting.textContent ?? "").toMatch(/needs your yes/i);
    const text = container.textContent ?? "";
    expect(text.search(/needs your yes/i)).toBeLessThan(text.indexOf("Following"));
  });

  it("the last pending email card approved leaves no empty waiting region behind", async () => {
    apiFetch.mockImplementation(approveRoutes([bulk]));
    const { container } = mount();
    await waitFor(() => expect(screen.getByTestId("email-card-dec-bulk")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Approve email dec-bulk" }));

    await waitFor(() => expect(container.querySelector(FOLLOWING)?.querySelector('[data-testid="email-card-dec-bulk"]')).toBeTruthy());
    expect(container.querySelector(WAITING)).toBeNull();
  });

  function approvedThenGone(pending: unknown[]) {
    let approved = false;
    return (path: string, opts?: { method?: string }) => {
      if (/^\/api\/approvals\/[^/]+\/approve$/.test(path) && opts?.method === "POST") {
        approved = true;
        return Promise.resolve(ok({}));
      }
      return routes({ threads: [thread()], decisions: approved ? [] : pending })(path);
    };
  }

  it("an approved email card stays under Following after the agent tab is hidden and re-shown", async () => {
    let approved = false;
    apiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === "/api/approvals") {
        return Promise.resolve(ok({ decisions: approved ? [{ ...email, status: "approved" }, informational] : [email, informational] }));
      }
      return routes({ threads: [thread()] })(path);
    });
    const mounted = mount();
    await waitFor(() => expect(screen.getByTestId("email-card-dec-email")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Approve email dec-email" }));
    approved = true;
    await waitFor(() => expect(mounted.container.querySelector(FOLLOWING)).toBeTruthy());

    mounted.rerender(<ThreadFeed agentSlug="engineer" agentName="Engineer" isActive={false} onOpenThread={() => {}} />);
    mounted.rerender(<ThreadFeed agentSlug="engineer" agentName="Engineer" isActive onOpenThread={() => {}} />);
    await waitFor(() =>
      expect(apiFetch.mock.calls.filter((call) => call[0] === "/api/approvals")).toHaveLength(2),
    );
    await waitFor(() => expect(screen.getByText(/needs your yes/i)).toBeTruthy());

    expect(mounted.container.querySelector(FOLLOWING)?.querySelector('[data-testid="email-card-dec-email"]')).toBeTruthy();
    expect(mounted.container.querySelector(WAITING)?.querySelector('[data-testid="email-card-dec-email"]')).toBeFalsy();
    expect(mounted.container.querySelectorAll('[data-testid="email-card-dec-email"]')).toHaveLength(1);
  });

  it("an approved email card is still under Following after the page reloads", async () => {
    apiFetch.mockImplementation(approvedThenGone([bulk]));
    const first = mount();
    await waitFor(() => expect(screen.getByTestId("email-card-dec-bulk")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Approve email dec-bulk" }));
    await waitFor(() => expect(first.container.querySelector(FOLLOWING)).toBeTruthy());
    first.unmount();

    const reloaded = mount();
    await waitFor(() =>
      expect(reloaded.container.querySelector(FOLLOWING)?.querySelector('[data-testid="email-card-dec-bulk"]')).toBeTruthy(),
    );
    expect(reloaded.container.querySelector(WAITING)).toBeNull();
  });

  it("a followed email card belongs to its own agent only", async () => {
    apiFetch.mockImplementation(approvedThenGone([bulk]));
    const first = mount();
    await waitFor(() => expect(screen.getByTestId("email-card-dec-bulk")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Approve email dec-bulk" }));
    await waitFor(() => expect(first.container.querySelector(FOLLOWING)).toBeTruthy());

    first.rerender(<ThreadFeed agentSlug="email" agentName="Engineer" onOpenThread={() => {}} />);
    await waitFor(() => expect(first.container.querySelector(FOLLOWING)).toBeNull());
  });

  it("a followed card belongs to its own workspace: another workspace in the same tab never sees it, and stale entries are dropped", async () => {
    apiFetch.mockImplementation(approvedThenGone([bulk]));
    const first = mount();
    await waitFor(() => expect(screen.getByTestId("email-card-dec-bulk")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Approve email dec-bulk" }));
    await waitFor(() => expect(first.container.querySelector(FOLLOWING)).toBeTruthy());
    first.unmount();
    window.sessionStorage.setItem("zavi.threadFeed.following.engineer", JSON.stringify([bulk]));

    tenant.id = "t-2";
    const other = mount();
    await waitFor(() => expect(apiFetch.mock.calls.filter((c) => c[0] === "/api/approvals").length).toBeGreaterThan(1));
    await waitFor(() => expect(Object.keys(window.sessionStorage).filter((k) => k.startsWith("zavi.threadFeed.following."))).toEqual([]));
    expect(other.container.querySelector(FOLLOWING)).toBeNull();
  });

  it("nothing is followed or stored while the workspace is still unknown", async () => {
    tenant.id = undefined;
    window.sessionStorage.setItem("zavi.threadFeed.following.engineer", JSON.stringify([bulk]));
    apiFetch.mockImplementation(approvedThenGone([bulk]));
    const { container } = mount();
    await waitFor(() => expect(screen.getByTestId("email-card-dec-bulk")).toBeTruthy());
    expect(container.querySelector(FOLLOWING)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve email dec-bulk" }));
    await waitFor(() => expect(container.querySelector(FOLLOWING)?.querySelector('[data-testid="email-card-dec-bulk"]')).toBeTruthy());
    expect(Object.keys(window.sessionStorage).filter((k) => k.startsWith("zavi.threadFeed.following.") && k !== "zavi.threadFeed.following.engineer")).toEqual([]);
  });

  it("signing out clears every followed card from the tab", async () => {
    apiFetch.mockImplementation(approvedThenGone([bulk]));
    const first = mount();
    await waitFor(() => expect(screen.getByTestId("email-card-dec-bulk")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Approve email dec-bulk" }));
    await waitFor(() => expect(first.container.querySelector(FOLLOWING)).toBeTruthy());
    first.unmount();
    expect(tenant.clearers.length).toBeGreaterThan(0);

    for (const clear of tenant.clearers) clear();

    expect(Object.keys(window.sessionStorage).filter((k) => k.startsWith("zavi.threadFeed.following."))).toEqual([]);
    const reloaded = mount();
    await waitFor(() => expect(apiFetch.mock.calls.filter((c) => c[0] === "/api/approvals").length).toBeGreaterThan(1));
    expect(reloaded.container.querySelector(FOLLOWING)).toBeNull();
  });

  const HOUR = 60 * 60 * 1000;
  const stored = () => Object.keys(window.sessionStorage).filter((k) => k.startsWith("zavi.threadFeed.following."));

  async function followAt(t0: number, card: { current: unknown }) {
    const base = approvedThenGone([bulk]);
    apiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === "/api/email-cards/decisions/dec-bulk") {
        const c = card.current;
        if (c === "fail") return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
        if (c === "gone") return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
        return Promise.resolve(ok({ card: c }));
      }
      return base(path, opts);
    });
    vi.spyOn(Date, "now").mockReturnValue(t0);
    const first = mount();
    await waitFor(() => expect(screen.getByTestId("email-card-dec-bulk")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Approve email dec-bulk" }));
    await waitFor(() => expect(first.container.querySelector(FOLLOWING)).toBeTruthy());
    first.unmount();
  }

  const cardReads = () => apiFetch.mock.calls.filter((c) => c[0] === "/api/email-cards/decisions/dec-bulk").length;

  async function remountAt(at: number) {
    vi.mocked(Date.now).mockReturnValue(at);
    const before = cardReads();
    const view = mount();
    await waitFor(() => expect(apiFetch.mock.calls.filter((c) => c[0] === "/api/approvals").length).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 20));
    return { view, reads: cardReads() - before };
  }

  it("a followed card that finished sending is dropped from the tab a day after it was approved", async () => {
    const t0 = Date.parse("2026-10-28T10:00:00.000Z");
    const card = { current: { open: false, status: "sent" } as unknown };
    try {
      await followAt(t0, card);
      const sameDay = await remountAt(t0 + 23 * HOUR);
      expect(sameDay.view.container.querySelector(FOLLOWING)?.querySelector('[data-testid="email-card-dec-bulk"]')).toBeTruthy();
      expect(sameDay.reads).toBe(0);
      sameDay.view.unmount();

      const nextDay = await remountAt(t0 + 25 * HOUR);
      await waitFor(() => expect(stored()).toEqual([]));
      expect(nextDay.view.container.querySelector(FOLLOWING)).toBeNull();
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it("a multi-day send waiting for tomorrow stays under Following past a day, and only leaves once it finishes", async () => {
    const t0 = Date.parse("2026-10-28T10:00:00.000Z");
    const card = { current: { open: false, status: "waiting_for_tomorrow" } as unknown };
    try {
      await followAt(t0, card);
      for (const at of [t0 + 25 * HOUR, t0 + 3 * 24 * HOUR, t0 + 13 * 24 * HOUR]) {
        const r = await remountAt(at);
        expect(r.reads).toBe(1);
        expect(r.view.container.querySelector(FOLLOWING)?.querySelector('[data-testid="email-card-dec-bulk"]')).toBeTruthy();
        expect(stored()).toEqual(["zavi.threadFeed.following.t-1.engineer"]);
        r.view.unmount();
      }

      card.current = { open: false, status: "sending" };
      const sending = await remountAt(t0 + 4 * 24 * HOUR);
      expect(sending.view.container.querySelector(FOLLOWING)?.querySelector('[data-testid="email-card-dec-bulk"]')).toBeTruthy();
      sending.view.unmount();

      card.current = "fail";
      const unreadable = await remountAt(t0 + 5 * 24 * HOUR);
      expect(unreadable.view.container.querySelector(FOLLOWING)?.querySelector('[data-testid="email-card-dec-bulk"]')).toBeTruthy();
      expect(stored()).toHaveLength(1);
      unreadable.view.unmount();

      card.current = { open: false, status: "stopped" };
      const finished = await remountAt(t0 + 6 * 24 * HOUR);
      await waitFor(() => expect(finished.view.container.querySelector(FOLLOWING)).toBeNull());
      expect(stored()).toEqual([]);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it("a send still going after two weeks is dropped by the safety cap without a read, and a deleted card is dropped too", async () => {
    const t0 = Date.parse("2026-10-28T10:00:00.000Z");
    const card = { current: { open: false, status: "waiting_for_tomorrow" } as unknown };
    try {
      await followAt(t0, card);
      const capped = await remountAt(t0 + 15 * 24 * HOUR);
      expect(capped.reads).toBe(0);
      expect(capped.view.container.querySelector(FOLLOWING)).toBeNull();
      expect(stored()).toEqual([]);
      capped.view.unmount();
      vi.mocked(Date.now).mockRestore();

      cleanup();
      apiFetch.mockReset();
      window.sessionStorage.clear();
      card.current = "gone";
      await followAt(t0, card);
      const gone = await remountAt(t0 + 2 * 24 * HOUR);
      await waitFor(() => expect(gone.view.container.querySelector(FOLLOWING)).toBeNull());
      expect(stored()).toEqual([]);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it("switching workspace and agent many times registers one sign-out clearer, not one per switch", async () => {
    apiFetch.mockImplementation(routes({ threads: [thread()] }));
    const view = mount();
    await waitFor(() => expect(apiFetch.mock.calls.filter((c) => c[0] === "/api/approvals").length).toBeGreaterThan(0));
    for (const [t, slug] of [["t-2", "engineer"], ["t-1", "email"], ["t-3", "ads"], ["t-1", "engineer"]] as const) {
      tenant.id = t;
      view.rerender(<ThreadFeed agentSlug={slug} agentName="Engineer" onOpenThread={() => {}} />);
    }
    await waitFor(() => expect(tenant.clearers.length).toBeGreaterThanOrEqual(5));
    expect(new Set(tenant.clearers).size).toBe(1);
  });

  it("a rejected email card leaves the feed instead of being followed", async () => {
    apiFetch.mockImplementation(approveRoutes([email]));
    const { container } = mount();
    await waitFor(() => expect(screen.getByTestId("email-card-dec-email")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reject email dec-email" }));

    await waitFor(() => expect(screen.queryByTestId("email-card-dec-email")).toBeNull());
    expect(container.querySelector(FOLLOWING)).toBeNull();
    expect(container.querySelector(WAITING)).toBeNull();
  });
});
