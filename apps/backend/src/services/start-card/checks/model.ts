
import { getAnthropic } from "@/services/anthropic";
import { MODELS } from "@/services/llm/models";

const MODEL_TIMEOUT_MS = 20_000;

export type CompleteFn = (system: string, user: string) => Promise<string>;

export const defaultComplete: CompleteFn = async (system, user) => {
  const resp = await getAnthropic().messages.create(
    {
      model: MODELS.anthropic.haiku,
      max_tokens: 700,
      system,
      messages: [{ role: "user", content: user }],
    },
    { timeout: MODEL_TIMEOUT_MS },
  );
  const block = resp.content.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text : "";
};

export function firstJsonObject(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function askJson(
  complete: CompleteFn,
  label: string,
  system: string,
  user: string,
): Promise<Record<string, unknown> | null> {
  try {
    return firstJsonObject(await complete(system, user));
  } catch (e) {
    console.error(`[start-card] ${label} model call failed: ${(e as Error)?.message?.slice(0, 200)}`);
    return null;
  }
}
