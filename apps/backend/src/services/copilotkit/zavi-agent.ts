
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { createTranslator, encodeSse } from "./ag-ui-translate";
import { defaultPollDeps, pollThreadEvents, type PollDeps } from "./thread-event-poller";
import { UiToolsSchema } from "./ui-tools";

export type ZaviAgentDeps = {
  fetch: typeof fetch;
  baseUrl: string;
  pollDeps?: (tenantId: string, runId: string) => PollDeps;
};

export type ZaviRunArgs = {
  input: RunAgentInput;
  bearer: string;
  tenantId: string;
  defaultAgentSlug: string;
  signal?: AbortSignal;
};

export function pickUiTools(tools: RunAgentInput["tools"]): unknown[] {
  const candidates = ((tools ?? []) as Array<{ name: string; description: string; parameters?: unknown }>).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters ?? {},
  }));
  const ok: unknown[] = [];
  for (const c of candidates) {
    const r = UiToolsSchema.element.safeParse(c);
    if (r.success) ok.push(r.data);
  }
  return ok.slice(0, 8);
}

export function lastUserText(input: RunAgentInput): string | null {
  const msgs = input.messages ?? [];
  const last = msgs[msgs.length - 1] as { role?: string; content?: unknown } | undefined;
  if (!last || last.role !== "user") return null;
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : ""))
      .join("")
      .trim() || null;
  }
  return null;
}

export function viewContext(input: RunAgentInput): Array<{ description: string; value: string }> {
  const ctx = ((input.context ?? []) as Array<{ description: unknown; value: unknown }>).slice(0, 8);
  return ctx.map((c) => ({ description: String(c.description).slice(0, 80), value: String(c.value).slice(0, 500) }));
}

export function contextPreamble(input: RunAgentInput): string {
  const ctx = viewContext(input);
  if (ctx.length === 0) return "";
  const lines = ctx.map((c) => `- ${c.description}: ${c.value}`);
  return `[What the user is looking at right now]\n${lines.join("\n")}\n\n`;
}

export async function* runZaviAgent(deps: ZaviAgentDeps, args: ZaviRunArgs): AsyncGenerator<string> {
  const { input } = args;
  const emit = (e: BaseEvent) => encodeSse(e);
  const fail = (message: string, code: string) => emit({ type: EventType.RUN_ERROR, message, code } as BaseEvent);

  const text = lastUserText(input);
  if (!text) {
    yield fail("The last message must be from the user.", "no_user_message");
    return;
  }
  const props = (input.forwardedProps ?? {}) as Record<string, unknown>;
  const slug = typeof props.agent_slug === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(props.agent_slug) ? props.agent_slug : args.defaultAgentSlug;
  const threadId = typeof props.zavi_thread_id === "string" && /^[0-9a-f-]{36}$/i.test(props.zavi_thread_id) ? props.zavi_thread_id : null;

  let res: Response;
  try {
    res = await deps.fetch(`${deps.baseUrl}/api/agents/${encodeURIComponent(slug)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${args.bearer}` },
      body: JSON.stringify({
        message: text.slice(0, 32000),
        ...(viewContext(input).length > 0 ? { view_context: viewContext(input) } : {}),
        thread_id: threadId,
        ui_tools: pickUiTools(input.tools),
      }),
      signal: args.signal,
    });
  } catch (e) {
    yield fail(`chat-send unreachable: ${(e as Error).message}`, "chat_send_unreachable");
    return;
  }
  if (res.status !== 202) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    yield fail(body?.error?.message ?? `chat-send answered ${res.status}`, body?.error?.code ?? `http_${res.status}`);
    return;
  }
  const started = (await res.json()) as { run_id: string; thread_id: string };

  const translator = createTranslator({ threadId: started.thread_id, runId: started.run_id });
  const poll = (deps.pollDeps ?? defaultPollDeps)(args.tenantId, started.run_id);
  yield emit({ type: EventType.CUSTOM, name: "zavi.run_accepted", value: { run_id: started.run_id, thread_id: started.thread_id } } as BaseEvent);

  try {
    const gen = pollThreadEvents(poll, translator.finished, args.signal);
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        if (next.value === "finished" || next.value === "aborted") return;
        yield fail(next.value === "timeout" ? "run exceeded the hard cap" : "run ended without a result", next.value);
        return;
      }
      for (const e of translator.push(next.value)) yield emit(e);
    }
  } catch (e) {
    yield fail(`stream failed: ${(e as Error).message}`, "stream_failed");
  }
}
