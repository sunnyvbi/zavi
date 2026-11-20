
import { z } from "zod";
import { getAnthropic, DEFAULT_MODEL } from "@/services/anthropic";
import { extractJsonObject } from "@/services/llm/extract-json";
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";

const cardSchema = z.object({
  title: z.string().min(3).max(200),
  body: z.string().max(2000).default(""),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  source_excerpt: z.string().max(600).default(""),
  worth_remembering: z.boolean().default(true),
});

export type DistilledCard = z.infer<typeof cardSchema>;

const MAX_INPUT_CHARS = 40_000;

const SYSTEM = `You turn a captured chunk of team conversation into ONE durable fact worth saving to a company memory, OR decide there is nothing worth remembering.

A good memory is a durable operating truth: a decision, a commitment (who owes what), a policy, a product/spec fact, a customer fact, a blocker that matters beyond today. NOT: small talk, transient status, "ok thanks", or anything already obvious.

Rules:
- Produce ONE fact. title = the fact in one line (<=200 chars). body = supporting detail (optional). source_excerpt = a short verbatim quote from the input that grounds it.
- confidence: high only if the input states the fact explicitly and unambiguously; low if you're inferring or the text is thin.
- If there is genuinely nothing durable worth saving, set worth_remembering=false (title can be a 3-char placeholder).
- Conversations come from chat; names/numbers may be informal — when a number/threshold matters, keep confidence at most medium unless it's repeated.

Return ONLY a JSON object: {"title","body","confidence","source_excerpt","worth_remembering"}.
Start your response with the character { and end it with }. No preamble sentence, no explanation, no markdown fences, no trailing prose.`;

export async function distillCard(
  input: { text: string; who?: string | null; context?: string | null },
): Promise<DistilledCard | null> {
  const text = (input.text ?? "").slice(0, MAX_INPUT_CHARS);
  if (text.trim().length < 10) return null;

  const userMsg = [
    input.context ? `Context: ${input.context}.` : "",
    input.who ? `Requested by: ${input.who}.` : "",
    renderUntrustedBlock("captured_text", text),
  ]
    .filter(Boolean)
    .join("\n\n");

  const anthropic = getAnthropic();
  const resp = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 1200,
    system: SYSTEM,
    messages: [
      { role: "user", content: userMsg },
    ],
  });

  const block = resp.content.find((c) => c.type === "text");
  const raw = block && block.type === "text" ? block.text : "";

  const parsed = extractJsonObject(raw);
  if (parsed === null) return null;

  const r = cardSchema.safeParse(parsed);
  if (!r.success) return null;
  if (!r.data.worth_remembering) return null;
  return r.data;
}
