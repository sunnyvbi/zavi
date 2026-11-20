import { createMessageWithFailover, hasAnthropicAuth, DEFAULT_FAST_MODEL, cachedSystemBlock } from "@/services/anthropic";
import { z } from "zod";

export type IdeaIntake = {
  company_name: string | null;
  what_we_sell: string | null;
};

const EMPTY: IdeaIntake = { company_name: null, what_we_sell: null };

const MIN_IDEA_CHARS = 8;
const MAX_NAME_CHARS = 60;
const MAX_WHAT_WE_SELL_CHARS = 200;

const IntakeLlmSchema = z.object({
  company_name: z.string().optional(),
  what_we_sell: z.string().optional(),
});

function stripJsonFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function cleanLine(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  return oneLine.slice(0, max).trim() || null;
}

export function extractIntake(raw: string): IdeaIntake | null {
  const candidates: string[] = [];
  const tag = raw.match(/<intake_json>([\s\S]*?)<\/intake_json>/);
  if (tag) candidates.push(stripJsonFence(tag[1]));
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const bare = raw.match(/\{[\s\S]*\}/);
  if (bare) candidates.push(bare[0]);

  for (const candidate of candidates) {
    try {
      const parsed = IntakeLlmSchema.parse(JSON.parse(candidate));
      return {
        company_name: cleanLine(parsed.company_name, MAX_NAME_CHARS),
        what_we_sell: cleanLine(parsed.what_we_sell, MAX_WHAT_WE_SELL_CHARS),
      };
    } catch {
      continue;
    }
  }
  return null;
}

export async function extractIdeaIntake(idea: string): Promise<IdeaIntake> {
  const trimmed = (idea ?? "").trim();
  if (!hasAnthropicAuth()) return EMPTY;
  if (trimmed.length < MIN_IDEA_CHARS) return EMPTY;

  const system = `You turn a founder's raw product idea into structured intake fields for a company workspace.

Return only a JSON object inside <intake_json> tags.

company_name — a short, clean brand name for this business (2-3 words max, Title Case). Prefer a name the founder states themselves (e.g. "my app is called Acme"). If none is stated, invent a simple descriptive brand from what the product IS. NEVER start with a verb like Create/Build/Make, never copy the instruction phrasing, no quotes, no "App"/"Inc" filler unless natural.

what_we_sell — ONE declarative sentence (max 200 chars) describing what the business offers its customers, written as a product description, not an instruction. Start with the offering, not with "Create" or "Build".

Rules:
1. Ground both fields ONLY in the idea text. Do not invent features that are not implied.
2. Plain text only, no markdown.
3. If the idea is too vague to name, return an empty string for company_name.`;

  const user = `THE IDEA:
${trimmed.slice(0, 4000)}

Return: <intake_json>{"company_name":"...","what_we_sell":"..."}</intake_json>`;

  try {
    const resp = await createMessageWithFailover(
      {
        model: DEFAULT_FAST_MODEL,
        max_tokens: 200,
        system: [cachedSystemBlock(system)],
        messages: [{ role: "user", content: user }],
      },
      { signal: AbortSignal.timeout(10_000) },
    );
    const raw = resp.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();
    return extractIntake(raw) ?? EMPTY;
  } catch {
    return EMPTY;
  }
}
