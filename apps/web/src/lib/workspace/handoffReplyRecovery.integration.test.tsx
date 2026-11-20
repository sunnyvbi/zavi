// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

type Thread = {
  id: string;
  tenant_id?: string;
  agent_slug: string;
  title: string | null;
  last_message_at: string;
  created_at: string;
};
type Msg = {
  id: string;
  tenant_id: string;
  body: string;
  sender_role: "user" | "assistant";
  agent_run_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  attachments: null;
  thread_id: string;
};

const db = {
  threads: new Map<string, Thread>(),
  messages: [] as Msg[],
  runs: new Map<string, { status: string; started_at: string; enqueued_at: string }>(),
  artifacts: [] as Array<{ id: string; run_id: string; filename: string; mime: string; bytes: number }>,
  threadError: null as string | null,
  messagesError: null as string | null,
  messageQueries: 0,
  draft: null as null | { run_id: string; seq: number; status: string; text: string },
};

function resolveQuery(table: string, filters: Record<string, unknown>) {
  if (table === "agent_run_stream_drafts") return { data: db.draft, error: null };
  if (table === "agent_threads") {
    if (db.threadError) return { data: null, error: { message: db.threadError } };
    if (filters.id === undefined && typeof filters.agent_slug === "string") {
      const latest = [...db.threads.values()]
        .filter((t) => t.agent_slug === filters.agent_slug)
        .filter((t) => filters.tenant_id === undefined || (t.tenant_id ?? "tenant-1") === filters.tenant_id)
        .sort((a, b) => (a.last_message_at < b.last_message_at ? 1 : -1))[0];
      return { data: latest ?? null, error: null };
    }
    return { data: db.threads.get(filters.id as string) ?? null, error: null };
  }
  if (table === "agent_thread_messages") {
    db.messageQueries++;
    if (db.messagesError) return { data: null, error: { message: db.messagesError } };
    const hideSuperseded = filters["filter:meta->>superseded_by"] !== undefined;
    const rows = db.messages
      .filter((m) => m.thread_id === filters.thread_id)
      .filter((m) => !hideSuperseded || !m.meta?.superseded_by)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { data: rows, error: null };
  }
  if (table === "agent_runs" && typeof filters.id === "string") {
    return { data: db.runs.get(filters.id) ?? null, error: null };
  }
  if (table === "run_artifacts" && Array.isArray(filters.run_id)) {
    const ids = filters.run_id as string[];
    return { data: db.artifacts.filter((a) => ids.includes(a.run_id)), error: null };
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
    filter: (col: string, op: string, val: unknown) => {
      filters[`filter:${col}`] = [op, val];
      return b;
    },
    order: self,
    limit: self,
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

const fakeSupabase = {
  from: (table: string) => builder(table),
  rpc: () => Promise.resolve({ data: [], error: null }),
};

vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => fakeSupabase }));
const activeTenant = vi.hoisted(() => ({ id: "tenant-1" as string | null }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: () => Promise.resolve(activeTenant.id) }));
const { realtimeCalls } = vi.hoisted(() => ({
  realtimeCalls: [] as Array<{ table: string; event?: string; filter?: string; enabled?: boolean; onInsert?: (row: unknown) => void; onSubscribed?: () => void }>,
}));
vi.mock("./useRealtimeChannel", () => ({
  useRealtimeChannel: (o: { table: string; event?: string; filter?: string; enabled?: boolean; onInsert?: (row: unknown) => void; onSubscribed?: () => void }) => {
    realtimeCalls.push(o);
  },
}));
vi.mock("./sessionScopedCache", () => ({ registerSessionScopedCache: () => {} }));
const notifyFiles = vi.fn();
vi.mock("./useWorkspaceFiles", () => ({ notifyWorkspaceFilesChanged: () => notifyFiles() }));

import { useChatThread } from "./useChatThread";

let seq = 0;
function uuid() {
  seq++;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

function addThread(slug = "operator"): string {
  const id = uuid();
  db.threads.set(id, {
    id,
    agent_slug: slug,
    title: null,
    last_message_at: "2026-09-16T10:00:00Z",
    created_at: "2026-09-16T10:00:00Z",
  });
  return id;
}

function addMsg(threadId: string, m: Partial<Msg> & Pick<Msg, "body" | "sender_role">) {
  db.messages.push({
    id: uuid(),
    tenant_id: "tenant-1",
    agent_run_id: null,
    meta: null,
    created_at: `2026-09-16T10:00:0${db.messages.length}Z`,
    attachments: null,
    thread_id: threadId,
    ...m,
  });
}

const texts = (rows: { body: unknown }[]) =>
  rows.map((r) => (r.body as { text?: string })?.text);

vi.mock("@/lib/realtimeAuth", () => ({ getBrowserSupabaseSingleton: () => fakeSupabase }));
const transport = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: transport.api }));
vi.mock("@/components/workspace/WorkspaceShell", () => ({ useWorkspace: () => ({ seedComposer: vi.fn(), openAgentTab: vi.fn() }) }));
vi.mock("./useAgentRun", () => ({ useAgentRun: () => ({ send: vi.fn(), inflight: false }) }));
vi.mock("@/components/workspace/ChatBubble", () => ({
  ChatBubble: ({ role, text, isStreaming }: { role: string; text: string; isStreaming?: boolean }) =>
    <div data-testid={`bubble-${role}`} data-streaming={isStreaming ? "yes" : "no"}>{text}</div>,
}));
import { ChatThread } from "@/components/workspace/ChatThread";
import { buildRunPanel } from "@zavi/shared";
import type { HandoffRun } from "./useHandoffProgress";

const CHILD = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const OPENING = "I will check your saved strategy and connected data.";
const ACK = "Your growth agent is preparing the plan.";
const ANSWER = "Your 30-day plan is ready. Start with the email campaign, then publish four videos.";
const at = (sec: number) => new Date(Date.UTC(2026, 10, 17, 8, 0, sec)).toISOString();
const activity = [
  { id: "say", kind: "reasoning", body: { text: OPENING } },
  { id: "tool-start", kind: "tool_call", body: { tool_name: "mcp__server__memory__search", call_id: "c1", target: "{}", code: "ok", ms: 0, output_preview: "" } },
  { id: "tool-end", kind: "tool_call", body: { tool_name: "mcp__server__memory__search", call_id: "c1", target: "", code: "ok", ms: 200, output_preview: "Strategy found" } },
];
let handoff: HandoffRun;
let chat: ReturnType<typeof useChatThread>;
function Surface({ threadId }: { threadId: string }) {
  chat = useChatThread("operator", threadId);
  return <ChatThread agentSlug="operator" threadId={threadId} state={{ ...chat, pendingRunId: null }} onRetry={chat.refetch} />;
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function settle() { await act(async () => { await Promise.resolve(); }); }
function setupThread() {
  const id = addThread();
  addMsg(id, { body: "What is my 30 day strategy?", sender_role: "user", agent_run_id: PARENT, created_at: at(0) });
  addMsg(id, { body: ACK, sender_role: "assistant", agent_run_id: PARENT, created_at: at(15) });
  db.runs.set(PARENT, { status: "success", started_at: at(1), enqueued_at: at(0) });
  db.runs.set(CHILD, { status: "running", started_at: at(13), enqueued_at: at(12) });
  return id;
}
function finishRun() {
  handoff = { ...handoff, status: "success", panel: buildRunPanel(activity, { state: "finished" }) };
  db.runs.set(CHILD, { status: "success", started_at: at(13), enqueued_at: at(12) });
}
function saveAnswer(id: string) {
  addMsg(id, { body: ANSWER, sender_role: "assistant", agent_run_id: CHILD, created_at: at(89), meta: { handoff: true, from_agent_slug: "cgo" } });
}
function notifyMessage() {
  const opts = realtimeCalls.filter(x => x.table === "agent_thread_messages" && x.event !== "UPDATE").at(-1);
  if (!opts?.onInsert) throw new Error("No message subscription registered");
  opts.onInsert({});
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at(40)));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  db.threads.clear(); db.messages = []; db.runs.clear(); db.draft = null;
  db.threadError = null; db.messagesError = null; db.messageQueries = 0; realtimeCalls.length = 0;
  handoff = { run_id: CHILD, parent_run_id: PARENT, agent_slug: "cgo", status: "running", started_at: at(13), panel: buildRunPanel(activity, { state: "running" }) };
  transport.api.mockReset().mockImplementation(async (path: string) => ({ ok: true, json: async () => path.includes("handoff-progress") ? { runs: [handoff] } : {} }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("handoff reply recovery — real chat hooks with synthetic transport", () => {
  it("normal message notification shows the canonical answer once and removes the live child", async () => {
    const id = setupThread(); render(<Surface threadId={id} />); await settle();
    expect(screen.getByText(ACK)).toBeTruthy();
    expect(screen.getByText(OPENING)).toBeTruthy();
    finishRun(); saveAnswer(id); await act(async () => notifyMessage()); await settle();
    expect(screen.getAllByText(ANSWER)).toHaveLength(1);
    expect(screen.getByText(ANSWER).getAttribute("data-streaming")).toBe("no");
    expect(screen.queryByText("Reading the results…")).toBeNull();
  });

  it("recovers the canonical reply without a message notification and stops refreshing", async () => {
    const id = setupThread();
    db.draft = { run_id: CHILD, seq: 1, status: "streaming", text: OPENING };
    render(<Surface threadId={id} />); await settle();
    finishRun(); saveAnswer(id);
    db.draft = { run_id: CHILD, seq: 24, status: "complete", text: ANSWER };
    await advance(2000);
    expect(screen.getAllByText(ANSWER)).toHaveLength(1);
    expect(screen.getByText(ANSWER).getAttribute("data-streaming")).toBe("no");
    expect(texts(chat.rows)).toContain(ANSWER);
    const reads = db.messageQueries;
    await advance(120000);
    expect(db.messageQueries).toBe(reads);
  });

  it("recovers a saved answer with no draft and no message notification", async () => {
    const id = setupThread(); render(<Surface threadId={id} />); await settle();
    finishRun(); saveAnswer(id); await advance(2000);
    expect(texts(chat.rows)).toContain(ANSWER);
    expect(screen.getByText(ANSWER).getAttribute("data-streaming")).toBe("no");
    expect(screen.queryByText("Reading the results…")).toBeNull();
  });

  it("retries when the run finishes before the answer is saved, even after progress polling stops", async () => {
    const id = setupThread(); render(<Surface threadId={id} />); await settle();
    await advance(46000); finishRun(); await advance(2000);
    expect(screen.queryByText(ANSWER)).toBeNull();
    const progressReads = transport.api.mock.calls.length;
    await advance(1500);
    expect(transport.api.mock.calls.length).toBe(progressReads);
    saveAnswer(id); await advance(2000);
    expect(screen.getAllByText(ANSWER)).toHaveLength(1);
    expect(screen.getByText(ANSWER).getAttribute("data-streaming")).toBe("no");
  });

  it("shows a completed draft as settled while waiting for the canonical save", async () => {
    const id = setupThread();
    db.draft = { run_id: CHILD, seq: 24, status: "complete", text: ANSWER };
    render(<Surface threadId={id} />); await settle();
    expect(screen.getByText(ANSWER).getAttribute("data-streaming")).toBe("no");
    expect(texts(chat.rows)).not.toContain(ANSWER);
    finishRun(); await advance(2000);
    saveAnswer(id); await advance(1000);
    expect(texts(chat.rows)).toContain(ANSWER);
    expect(screen.getAllByText(ANSWER)).toHaveLength(1);
  });

  it("retries a failed conversation read without removing the existing conversation", async () => {
    const id = setupThread(); render(<Surface threadId={id} />); await settle();
    db.messagesError = "temporary read failure";
    finishRun(); saveAnswer(id); await advance(2000);
    expect(screen.getByText(ACK)).toBeTruthy();
    expect(screen.queryByText(ANSWER)).toBeNull();
    db.messagesError = null; await advance(1000);
    expect(screen.getByText(ANSWER).getAttribute("data-streaming")).toBe("no");
  });

  it("a failed handoff poll recovers: Reading the results does not remain after a successful terminal poll", async () => {
    const id = setupThread(); render(<Surface threadId={id} />); await settle();
    expect(screen.getByText("Reading the results…")).toBeTruthy();
    transport.api.mockRejectedValueOnce(new Error("network unavailable")); await advance(2000);
    expect(screen.getByText("Reading the results…")).toBeTruthy();
    finishRun(); await advance(4000);
    expect(screen.queryByText("Reading the results…")).toBeNull();
  });

  it("returning to the visible tab recovers a saved answer after a missed notification", async () => {
    const id = setupThread(); render(<Surface threadId={id} />); await settle();
    finishRun(); await advance(120000); saveAnswer(id);
    expect(screen.queryByText(ANSWER)).toBeNull();
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getAllByText(ANSWER)).toHaveLength(1);
    expect(screen.getByText(ANSWER).getAttribute("data-streaming")).toBe("no");
  });

  it("a subscription rejoin recovers a saved answer after a missed notification", async () => {
    const id = setupThread(); render(<Surface threadId={id} />); await settle();
    finishRun(); await advance(120000); saveAnswer(id);
    expect(screen.queryByText(ANSWER)).toBeNull();
    const subscription = realtimeCalls.filter(x => x.table === "agent_thread_messages" && x.event !== "UPDATE").at(-1);
    expect(subscription?.onSubscribed).toBeTypeOf("function");
    await act(async () => subscription!.onSubscribed!());
    await advance(1000);
    expect(screen.getAllByText(ANSWER)).toHaveLength(1);
    expect(screen.getByText(ANSWER).getAttribute("data-streaming")).toBe("no");
  });

  it("running child shows elapsed time from its actual start alongside its tools", async () => {
    const id = setupThread(); render(<Surface threadId={id} />); await settle();
    expect(screen.getByText("Reading the results…")).toBeTruthy();
    expect(screen.getByText(/1 tool/)).toBeTruthy();
    await advance(20000);
    const line = screen.getByRole("status").parentElement;
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain("47s");
  });

  it("shows one active status, with the acknowledgement and narration in disclosures", async () => {
    const id = setupThread(); render(<Surface threadId={id} />); await settle();
    expect(screen.queryByTestId("bubble-assistant")).toBeNull();
    expect(screen.getByText(ACK).tagName).toBe("P");
    expect(screen.getByText(OPENING).closest("details")?.open).toBe(false);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Reading the results…");
  });

  it("keeps substantial parent answers and combined specialist answers as bubbles", async () => {
    const id = setupThread();
    const substantive = "## Current results\n\nRevenue increased. The specialist will check the next steps.";
    db.messages[1].body = substantive;
    render(<Surface threadId={id} />); await settle();
    expect(screen.getByTestId("bubble-assistant").textContent).toBe(substantive);
    db.messages[1].body = ANSWER;
    db.messages[1].meta = { child_run_ids: [CHILD] };
    await act(async () => notifyMessage()); await settle();
    expect(screen.getByTestId("bubble-assistant").textContent).toBe(ANSWER);
    expect(screen.queryByText("Reading the results…")).toBeNull();
  });

  it("offers a read-only reload after exhaustion, and replaces the status with the answer", async () => {
    const id = setupThread(); render(<Surface threadId={id} />); await settle();
    finishRun(); await advance(2000);
    expect(screen.getByRole("status").textContent).toBe("Loading your completed answer…");
    await advance(65000);
    expect(screen.getByRole("status").textContent).toContain("hasn’t loaded yet");
    saveAnswer(id);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reload answer" })));
    await settle();
    expect(screen.getAllByText(ANSWER)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Reload answer" })).toBeNull();
    expect(transport.api.mock.calls.every(([path]) => !String(path).includes("send"))).toBe(true);
  });

  it("moves keyboard focus to the loading status while a manual reload waits", async () => {
    const id = setupThread(); render(<Surface threadId={id} />); await settle();
    finishRun(); await advance(2000); await advance(65000);
    const button = screen.getByRole("button", { name: "Reload answer" });
    button.focus();
    await act(async () => fireEvent.click(button));
    expect(document.activeElement).toBe(screen.getByRole("status"));
    expect(screen.getByRole("status").textContent).toBe("Loading your completed answer…");
  });
});
