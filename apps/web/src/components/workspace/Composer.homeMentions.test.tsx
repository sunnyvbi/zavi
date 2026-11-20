// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

type Msg = {
  id: string;
  body: string;
  sender_role: "user" | "assistant";
  agent_run_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  attachments: null;
  thread_id: string;
};

const db = vi.hoisted(() => ({
  threads: new Map<string, { id: string; agent_slug: string; title: string | null; last_message_at: string; created_at: string }>(),
  messages: [] as Msg[],
}));

const net = vi.hoisted(() => ({
  calls: [] as { message: string; thread_id: string | null }[],
  urls: [] as string[],
  bodies: [] as Record<string, unknown>[],
  respond: null as null | ((body: { message: string; thread_id: string | null }) => Promise<unknown>),
}));

const ws = vi.hoisted(() => ({ bind: (_id: string | null) => {}, keepClicked: false }));

function resolveQuery(table: string, filters: Record<string, unknown>) {
  if (table === "agent_threads") {
    return { data: db.threads.get(filters.id as string) ?? null, error: null };
  }
  if (table === "agent_thread_messages" && filters["filter:meta->>team_note_state"]) {
    return { data: [], error: null };
  }
  if (table === "agent_thread_messages") {
    const rows = db.messages
      .filter((m) => m.thread_id === filters.thread_id)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { data: rows, error: null };
  }
  return { data: null, error: null };
}

function builder(table: string) {
  const filters: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  const self = () => b;
  Object.assign(b, {
    select: self,
    is: self,
    order: self,
    limit: self,
    filter: (col: string, op: string, val: unknown) => {
      filters[`filter:${col}`] = [op, val];
      return b;
    },
    in: (col: string, vals: unknown) => {
      filters[col] = vals;
      return b;
    },
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return b;
    },
    maybeSingle: () => Promise.resolve(resolveQuery(table, filters)),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(resolveQuery(table, filters)).then(res, rej),
  });
  return b;
}

vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: [], error: null }),
  }),
}));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: () => Promise.resolve("tenant-1") }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("@/lib/workspace/sessionScopedCache", () => ({ registerSessionScopedCache: () => {} }));
vi.mock("@/lib/workspace/useWorkspaceFiles", () => ({ notifyWorkspaceFilesChanged: () => {} }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("./WorkspaceShell", () => {
  const noop = () => {};
  return {
    useWorkspace: () => ({
      setTabDirty: noop,
      setTabThreadId: (_tab: string, id: string | null) => ws.bind(id),
      role: "owner",
      composerSeeds: {},
      consumeComposerSeed: noop,
      closeTab: noop,
      openTab: noop,
      currentUserId: "user-1",
      tenantId: "tenant-1",
      supplyDemandEligible: false,
      treeAgents: [
        { slug: "engineer", locked_tier: "pro" },
        { slug: "fundraising" },
        { slug: "c-abcd1234", name: "Catering quotes", custom: true },
      ],
    }),
  };
});
vi.mock("@/lib/workspace/tenantCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/tenantCommands")>()),
  useTenantCommands: () => ({ commands: [], loaded: true, error: null }),
}));
vi.mock("@/lib/workspace/useFeedback", () => ({ submitFeedback: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (url: string, init?: { body?: string }) => {
    if (!url.endsWith("/chat") || !init?.body) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    }
    const body = JSON.parse(init.body) as { message: string; thread_id?: string | null };
    net.urls.push(url);
    net.bodies.push(body as Record<string, unknown>);
    const entry = { message: body.message, thread_id: body.thread_id ?? null };
    net.calls.push(entry);
    return net.respond!(entry);
  }),
}));

import { Composer, createComposerDraft } from "./Composer";

Element.prototype.scrollIntoView = () => {};

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

function HomeComposer({ home = true, agentSlug = "operator" }: { home?: boolean; agentSlug?: string }) {
  const [draft] = useState(createComposerDraft);
  const [bound, setBound] = useState<string | null>(null);
  return (
    <Composer
      agentSlug={agentSlug}
      tabId="home"
      threadId={bound}
      onThreadBound={setBound}
      draft={draft}
      onSent={() => {}}
      homeMentions={home}
    />
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
function send(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: "Enter" });
}

beforeEach(() => {
  db.threads.clear();
  db.messages = [];
  net.calls = [];
  net.urls = [];
  net.bodies = [];
  net.respond = async () => ok({ thread_id: "th-new", user_message_id: "u1", run_id: "run-1" });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

const ASK = "what is holding my growth back?";

describe("the Home composer's @ list", () => {
  it("shows the @ Ask door and the quiet line on Home only", async () => {
    render(<HomeComposer />);
    expect(screen.getByRole("button", { name: /Ask Your CGO, a channel or your team/ })).toBeTruthy();
    expect(screen.getByText("Growth questions go to Your CGO. It knows your plan.")).toBeTruthy();
    cleanup();

    render(<HomeComposer home={false} />);
    expect(screen.queryByRole("button", { name: /Ask Your CGO, a channel or your team/ })).toBeNull();
    expect(screen.queryByText(/Growth questions go to Your CGO/)).toBeNull();
  });

  it("@ Ask opens the list with Your CGO first, then the team, and plan-locked last", async () => {
    render(<HomeComposer />);
    fireEvent.click(screen.getByRole("button", { name: /Ask Your CGO, a channel or your team/ }));
    await flush();

    expect(box().value).toBe("@");
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options[0]).toContain("Your CGO");
    expect(options[0]).toContain("plan, goals, where to spend");
    const team = screen.getByRole("group", { name: "Your team" });
    const names = Array.from(team.querySelectorAll('[role="option"]')).map((o) => o.textContent ?? "");
    expect(names[0]).toContain("Fundraising");
    expect(names[1]).toContain("Catering quotes");
    expect(names[2]).toContain("Engineer");
    expect(names[2]).toContain("Pro plan");
  });

  it("picking Your CGO makes a chip, sends @cgo in THIS thread, and remembers it", async () => {
    render(<HomeComposer />);
    fireEvent.change(box(), { target: { value: "@" } });
    await flush();
    fireEvent.mouseDown(screen.getAllByRole("option")[0]);
    await flush();

    const chip = screen.getByRole("button", { name: "Remove Your CGO" });
    const suffix = chip.nextElementSibling as HTMLSpanElement;
    suffix.textContent = ASK;
    fireEvent.input(screen.getByRole("textbox"));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await flush();

    expect(net.urls).toEqual(["/api/agents/operator/chat"]);
    expect(net.bodies[0]).toMatchObject({ message: `@cgo ${ASK}` });
    expect(JSON.parse(window.localStorage.getItem("zavi:mention-recent:user-1:tenant-1") ?? "[]")).toEqual([
      "agent:cgo",
    ]);
  });

  it("typing narrows the list", async () => {
    render(<HomeComposer />);
    fireEvent.change(box(), { target: { value: "@cater" } });
    await flush();
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options).toHaveLength(1);
    expect(options[0]).toContain("Catering quotes");
  });

  it.each([
    ["@cgo", "cgo"],
    ["@your cgo", "Your CGO"],
    ["@engineer", "engineer"],
    ["@c-abcd1234", "custom"],
  ])("a typed %s on Home stays with Zavi in this thread", async (address) => {
    render(<HomeComposer />);
    send(`${address} ${ASK}`);
    await flush();

    expect(net.urls).toEqual(["/api/agents/operator/chat"]);
    expect(net.bodies[0]).toMatchObject({ message: `${address} ${ASK}` });
  });

  it("an unknown workspace's custom slug is not held on Home", async () => {
    render(<HomeComposer />);
    send(`@c-zzzz9999 ${ASK}`);
    await flush();
    expect(net.urls).toEqual(["/api/agents/c-zzzz9999/chat"]);
  });

  it("off Home, a typed @cgo still routes to the CGO as before", async () => {
    render(<HomeComposer home={false} />);
    send(`@cgo ${ASK}`);
    await flush();
    expect(net.urls).toEqual(["/api/agents/cgo/chat"]);
  });

  it("off Home the list is today's flat Channels list", async () => {
    render(<HomeComposer home={false} />);
    fireEvent.change(box(), { target: { value: "@" } });
    await flush();
    expect(screen.queryByText("Your CGO")).toBeNull();
    expect(screen.getByRole("group", { name: "Channels" })).toBeTruthy();
  });
});
