
import { z } from "zod";
import { getAnthropic, cachedSystemBlock } from "@/services/anthropic";
import { MODELS } from "@/services/llm/models";
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";

export const MAX_TASKS = 4;

const DECOMPOSE_MODEL = MODELS.anthropic.haiku;

export const taskSpecSchema = z.object({
  title: z.string().min(1).max(120),
  task_description: z.string().min(1).max(2000),
});
export type TaskSpec = z.infer<typeof taskSpecSchema>;

export type EnrichedTaskSpec = TaskSpec & { repo?: string };

export type DecomposeResult =
  | { kind: "single" }
  | { kind: "multi"; tasks: TaskSpec[] };

const SYSTEM_PROMPT = `You split a software-engineering request into independent PR-sized tasks.

Rules:
- If the message is ONE coherent change — even if it touches several files or has sub-steps (e.g. "refactor X and update its callers", "add feature Y with its tests") — return {"single": true}.
- Split when the message contains 2+ GENUINELY INDEPENDENT changes that each warrant their own pull request (e.g. "fix the login redirect bug AND add a dark-mode toggle AND bump the eslint config").
- ALSO split when the SAME change must ship to 2+ DISTINCT PLATFORMS that live in separate repos (e.g. "send PRs for iOS and Android and web", "fix this on iOS and Android"). Emit ONE task per named platform. Each task's "title" MUST name its platform (e.g. "iOS: <change>", "Android: <change>", "Web: <change>"); each task_description restates the same change scoped to that platform. The server routes each task to its repo — you do NOT choose repos. Recognized platforms: iOS, Android, web (web/backend/frontend). Only split per-platform when the message EXPLICITLY names 2+ of these platforms; a single-platform ask (or no platform named) is {"single": true}.
- Each task: a short imperative "title" (<=120 chars) + a self-contained "task_description" an engineer can act on WITHOUT the other tasks.
- Never invent work not in the message. Never choose a repository or branch — only describe the work.
- When in doubt, prefer {"single": true} — never split on ambiguity.

Output STRICT JSON, no prose, EXACTLY one of:
  {"single": true}
  {"tasks": [{"title": "...", "task_description": "..."}, ...]}`;

const outputSchema = z.union([
  z.object({ single: z.literal(true) }),
  z.object({ tasks: z.array(z.unknown()) }),
]);

function parseJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function decomposeMessage(
  message: string,
  opts: { model?: string; throwOnError?: boolean } = {},
): Promise<DecomposeResult> {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return { kind: "single" };

  let raw = "";
  try {
    const anthropic = getAnthropic();
    const resp = await anthropic.messages.create({
      model: opts.model ?? DECOMPOSE_MODEL,
      max_tokens: 1024,
      system: [cachedSystemBlock(SYSTEM_PROMPT)],
      messages: [
        { role: "user", content: renderUntrustedBlock("operator_request", trimmed) },
      ],
    });
    const textBlock = resp.content.find((c) => c.type === "text");
    raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
  } catch (err) {
    if (opts.throwOnError) throw err;
    return { kind: "single" };
  }

  const top = outputSchema.safeParse(parseJsonObject(raw));
  if (!top.success) return { kind: "single" };
  if ("single" in top.data) return { kind: "single" };

  const tasks: TaskSpec[] = [];
  for (const t of top.data.tasks) {
    const v = taskSpecSchema.safeParse(t);
    if (v.success) tasks.push(v.data);
    if (tasks.length >= MAX_TASKS) break;
  }
  if (tasks.length <= 1) return { kind: "single" };
  return { kind: "multi", tasks };
}
