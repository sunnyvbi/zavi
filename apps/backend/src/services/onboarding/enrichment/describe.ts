import { hasAnthropicAuth } from "@/services/anthropic";
import { apiComplete, type EnrichmentComplete } from "./text-model";
import { logEvent } from "@/services/logging/logEvent";
import { z } from "zod";

const DescriptionLlmSchema = z.object({
  description: z.string(),
});

const MIN_CONTEXT_CHARS = 200;
const MIN_DESCRIPTION_CHARS = 20;
const DESCRIPTION_MAX_CHARS = 600;

type DescribeFailReason = "no_auth" | "thin_context" | "no_json" | "model_empty" | "llm_error";
function logDescribeFail(reason: DescribeFailReason, domain: string, detail = ""): void {
  void logEvent({
    level: "warn",
    source: "onboarding.describe",
    code: "describe_no_output",
    message: `onboarding.describe.no_output reason=${reason} domain=${domain}${detail ? ` ${detail}` : ""}`,
    meta: {},
  });
}

function stripJsonFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

export function extractDescription(
  raw: string,
): { description: string } | { reason: "no_json" | "model_empty" } {
  const candidates: string[] = [];
  const tag = raw.match(/<description_json>([\s\S]*?)<\/description_json>/);
  if (tag) candidates.push(stripJsonFence(tag[1]));
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const keyed = raw.match(/\{[^{}]*"description"[^{}]*\}/);
  if (keyed) candidates.push(keyed[0]);
  const bare = raw.match(/\{[\s\S]*\}/);
  if (bare) candidates.push(bare[0]);

  let sawValidButEmpty = false;
  for (const candidate of candidates) {
    try {
      const parsed = DescriptionLlmSchema.parse(JSON.parse(candidate));
      const description = parsed.description.trim().slice(0, DESCRIPTION_MAX_CHARS);
      if (description.length >= MIN_DESCRIPTION_CHARS) return { description };
      sawValidButEmpty = true;
    } catch {
    }
  }
  return { reason: sawValidButEmpty ? "model_empty" : "no_json" };
}

export async function describeCompany(
  orgName: string,
  domain: string,
  contextText: string,
  complete?: EnrichmentComplete,
): Promise<string | undefined> {
  if (!complete && !hasAnthropicAuth()) {
    logDescribeFail("no_auth", domain);
    return undefined;
  }
  if (contextText.trim().length < MIN_CONTEXT_CHARS) {
    logDescribeFail("thin_context", domain);
    return undefined;
  }

  const system = `You write a short, accurate description of a company from its own website content.
Return only a JSON object inside <description_json> tags.
1. Write 2-4 sentences on what THIS company sells or does, the specific customer/user it names or clearly implies, and the concrete mechanism/features shown in the text. Omit the audience or mechanism if the site does not state it — do not guess "businesses" or "teams".
2. Ground EVERY claim in the provided website content. Invent NO facts — no metrics, funding, customer counts, pricing, or integrations that are not present in the text.
3. Use concrete nouns from the text. Do NOT use vague filler like "streamlines operations", "empowers teams", "innovative solution", or "end-to-end platform" unless the text explains what it means. Write in the third person.
4. Describe the company itself, NOT its competitors. If it has several offerings, describe the clearest primary one. If the site is non-English, understand it as written but write the description in English.
5. If the content is too thin or ambiguous to describe the company, return an empty string.`;

  const user = `Company: ${orgName} (${domain})

Website content:
${contextText.slice(0, 8000)}

Return: <description_json>{"description":"..."}</description_json>`;

  try {
    const raw = await (complete ?? apiComplete)({ system, user, maxTokens: 400, timeoutMs: 30_000 });
    const result = extractDescription(raw);
    if ("description" in result) return result.description;
    logDescribeFail(result.reason, domain);
    return undefined;
  } catch (err) {
    logDescribeFail(
      "llm_error",
      domain,
      `err=${(err as { name?: string })?.name ?? "Error"} status=${(err as { status?: number })?.status ?? "none"}`,
    );
    return undefined;
  }
}
