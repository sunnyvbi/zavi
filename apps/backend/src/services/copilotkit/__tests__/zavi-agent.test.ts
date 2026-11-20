
import { describe, it, expect, vi } from "vitest";
import type { RunAgentInput } from "@ag-ui/core";
import { runZaviAgent, pickUiTools, lastUserText, contextPreamble } from "../zavi-agent";
import type { PollDeps } from "../thread-event-poller";

const input = (over: Partial<RunAgentInput> = {}): RunAgentInput =>
  ({
    threadId: "thr-1",
    runId: "run-x",
    messages: [{ id: "m1", role: "user", content: "open my calendar" }],
    tools: [
      { name: "open_tab", description: "Open a tab", parameters: { type: "object", properties: { kind: { type: "string" } } } },
      { name: "rm_rf", description: "nope", parameters: { type: "object", properties: { x: {} } } },
    ],
    context: [{ description: "Active tab", value: "calendar" }],
    state: {},
    forwardedProps: { agent_slug: "growth-lead", zavi_thread_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    ...over,
  }) as RunAgentInput;

const rows = [
  { id: 1, kind: "run_start", body: { trigger: "chat" } },
  { id: 2, kind: "chat_assistant", body: { text: "Done." } },
  { id: 3, kind: "run_end", body: { status: "succeeded" } },
];

function pollDeps(evs = rows): PollDeps {
  let served = false;
  return {
    fetchEvents: async () => (served ? [] : ((served = true), evs)),
    fetchRunStatus: async () => "running",
    sleep: async () => {},
    now: () => 0,
  };
}

async function collect(gen: AsyncGenerator<string>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for await (const chunk of gen) out.push(JSON.parse(chunk.replace(/^data: /, "").trim()));
  return out;
}

const ok202 = (body: unknown) => ({ status: 202, json: async () => body }) as unknown as Response;

describe("runZaviAgent", () => {
  it("POSTs the turn with bearer, gated ui_tools and context, then streams the run", async () => {
    const fetch = vi.fn(async () => ok202({ run_id: "run-1", thread_id: "thr-1" }));
    const evs = await collect(
      runZaviAgent(
        { fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: "http://127.0.0.1:3001", pollDeps: () => pollDeps() },
        { input: input(), bearer: "tok", tenantId: "t-1", defaultAgentSlug: "chief-of-staff" },
      ),
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3001/api/agents/growth-lead/chat");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const body = JSON.parse(String(init.body));
    expect(body.thread_id).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(body.ui_tools.map((t: { name: string }) => t.name)).toEqual(["open_tab"]);
    expect(body.message).toBe("open my calendar");
    expect(body.view_context).toEqual([{ description: "Active tab", value: "calendar" }]);
    expect(evs.map((e) => e.type)).toEqual([
      "CUSTOM", "RUN_STARTED", "STATE_SNAPSHOT",
      "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END",
      "STATE_DELTA", "RUN_FINISHED",
    ]);
    expect(evs[0]).toMatchObject({ name: "zavi.run_accepted", value: { run_id: "run-1" } });
  });

  it("a non-202 (402 insufficient_credits) becomes RUN_ERROR with the route's code", async () => {
    const fetch = vi.fn(async () => ({ status: 402, json: async () => ({ error: { code: "insufficient_credits", message: "Buy credits" } }) }) as unknown as Response);
    const evs = await collect(
      runZaviAgent({ fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: "http://x" }, { input: input(), bearer: "t", tenantId: "t-1", defaultAgentSlug: "chief-of-staff" }),
    );
    expect(evs).toEqual([{ type: "RUN_ERROR", message: "Buy credits", code: "insufficient_credits" }]);
  });

  it("a non-user last message never reaches chat-send", async () => {
    const fetch = vi.fn();
    const evs = await collect(
      runZaviAgent(
        { fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: "http://x" },
        { input: input({ messages: [{ id: "a", role: "assistant", content: "hi" }] as never }), bearer: "t", tenantId: "t-1", defaultAgentSlug: "chief-of-staff" },
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(evs[0]).toMatchObject({ type: "RUN_ERROR", code: "no_user_message" });
  });

  it("an unknown agent_slug falls back to the default; a bad thread id is dropped", async () => {
    const fetch = vi.fn(async () => ok202({ run_id: "r", thread_id: "t" }));
    await collect(
      runZaviAgent(
        { fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: "http://h", pollDeps: () => pollDeps() },
        { input: input({ forwardedProps: { agent_slug: "../etc", zavi_thread_id: "nope" } }), bearer: "t", tenantId: "t-1", defaultAgentSlug: "chief-of-staff" },
      ),
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://h/api/agents/chief-of-staff/chat");
    expect(JSON.parse(String(init.body)).thread_id).toBeNull();
  });
});

describe("helpers", () => {
  it("pickUiTools keeps only gated names (max 8)", () => {
    expect(pickUiTools(input().tools).map((t) => (t as { name: string }).name)).toEqual(["open_tab"]);
    expect(pickUiTools(undefined)).toEqual([]);
  });
  it("lastUserText handles string and parts content", () => {
    expect(lastUserText(input({ messages: [{ id: "m", role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] as never }))).toBe("ab");
    expect(lastUserText(input({ messages: [] }))).toBeNull();
  });
  it("contextPreamble is empty without context and bounded with it", () => {
    expect(contextPreamble(input({ context: [] }))).toBe("");
    expect(contextPreamble(input({ context: Array.from({ length: 12 }, (_, i) => ({ description: `d${i}`, value: "v" })) })).split("\n- ").length - 1).toBe(8);
  });
});
