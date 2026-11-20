import { apiUrl } from "../../lib/api";
import { landscapeForRequest, type BrainstormMsg, type Landscape } from "./idea";

type Reply = { ok?: boolean; error?: { message?: string }; [k: string]: unknown };

async function post(body: object): Promise<{ data: Reply | null; ok: boolean }> {
  const res = await fetch(apiUrl("/api/onboarding/brainstorm"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as Reply | null;
  return { data, ok: res.ok && !!data?.ok };
}

const fail = (data: Reply | null, fallback: string) => new Error(data?.error?.message ?? fallback);

export async function brainstormChat(seedIdea: string, landscape: Landscape | null, history: BrainstormMsg[]) {
  const { data, ok } = await post({
    seedIdea,
    mode: "chat",
    landscape: landscapeForRequest(landscape),
    history: history.map((m) => ({ role: m.role, text: m.text })),
  });
  if (!ok || !data) throw fail(data, "Brainstorm hit a snag. Try again.");
  return { message: String(data.message ?? ""), options: data.options as string[] | undefined, recommended: data.recommended as string | undefined, done: data.done === true };
}

export async function brainstormResearch(seedIdea: string) {
  const { data, ok } = await post({ seedIdea, mode: "research" });
  if (!ok || !data) throw fail(data, "Research hit a snag. Try again.");
  return { landscape: (data.landscape as Landscape) ?? null, message: String(data.message ?? "") };
}

export async function brainstormSummarize(seedIdea: string, landscape: Landscape | null, history: BrainstormMsg[]) {
  const { data, ok } = await post({
    seedIdea,
    mode: "summarize",
    landscape: landscapeForRequest(landscape),
    history: history.map((m) => ({ role: m.role, text: m.text, options: m.options })),
  });
  if (!ok || !data?.brief) throw fail(data, "Couldn't pull that together. Try again.");
  return String(data.brief).trim();
}
