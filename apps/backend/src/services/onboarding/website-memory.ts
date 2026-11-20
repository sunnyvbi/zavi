
import { z } from "zod";
import {
  createMessageWithFailover,
  DEFAULT_MODEL,
  cachedSystemBlock,
} from "@/services/anthropic";
import { sanitizeFetchedContent } from "@/services/onboarding/enrichment/sanitize";
import {
  ENRICHMENT_SYSTEM_SECTION,
  EnrichmentResultSchema,
  buildEnrichmentBlock,
} from "@/routes/onboarding/generate-memory";
import { placeholderBody } from "./placeholder-docs";

const TWO_DOC_SYSTEM_PROMPT = `You are writing 2 markdown "memory docs" for an AI agent fleet that runs the day-to-day for a company operator. The agents read these docs on every run to know HOW THIS OPERATOR thinks. Write in the OPERATOR'S voice — first-person plural ("we", "our") — concrete, opinionated, specific. No corporate fluff.

The 2 docs and their roles + what each MUST cover:

- company.md — Company brief. Cover (in this order):
    1) Positioning (one sentence): what we are + who we serve.
    2) What we do (2–3 sentences): the product / service / business shape, with concrete nouns.
    3) ICP (1–2 sentences): who our paying customer is, and the pain we solve for them.
    4) Differentiation (1 sentence): why us vs. the obvious alternative.
    5) Stage facts (1 sentence): ONLY facts actually present in the inputs (pre-launch / live in named markets). If a customer count, ARR, MRR, revenue, GMV, or headcount was NOT provided in the inputs, OMIT it entirely — never estimate, infer, or invent a number.
    6) GTM motion (one sentence): only state concrete customer-acquisition channels or sales motion EXPLICITLY present in the inputs or <enrichment>. Do NOT infer motion from company shape, stage, pricing page, blog existence, app-store listing, or generic SaaS/marketplace patterns. If there is no explicit GTM evidence at all, write exactly: "GTM motion: not specified yet - operator to confirm." Keep this to ONE sentence and do not repeat it in ops.md.

- ops.md — Operating priorities. Cover:
    1) Which surfaces / queues we work first.
    2) Spend caps per decision and per day (use a concrete $ if known, otherwise a placeholder).
    3) Eval threshold for letting an agent ship without review.
    4) Escalation chain: agent → operator-on-call → founder.

Output ONE JSON object inside <memory>...</memory> tags conforming to:

{
  "company": "# Company\\n\\n...full markdown body...",
  "ops":     "# Operating priorities\\n\\n..."
}

Hard rules:
- Both keys MUST be present and non-empty. Write ONLY company and ops: the ENRICHMENT guidance below (when present) also covers policies / disputes / support, which are written later by other agents — skip those parts.
- TARGET each doc at 150–250 words. Lean LONG, not short — these docs are read by the agent fleet on every run; thin bodies are a downstream failure mode.
- Concrete, not generic. Prefer specific numbers, names, scenarios from the inputs over abstractions.
- The operator profile below is what we know from signup (their website address and the company name). The <enrichment> block (when present) is SUPPORTING evidence read from their public site.
- NEVER fabricate facts that are not in the operator profile OR <enrichment>. Don't invent specific response times, escalation contacts, customer counts, ARR/MRR, revenue, GMV, headcount, valuation, or growth rates.
- HONEST FALLBACK: If the inputs are genuinely thin for a doc, write a SHORT honest "edit me" body (what is missing and what to add) instead of padding with generic marketing fluff.
- Output NOTHING outside the <memory>...</memory> tags.`;

const MEMORY_BLOCK_RE = /<memory>([\s\S]*?)<\/memory>/;
const TwoDocSchema = z.object({ company: z.string().min(1), ops: z.string().min(1) });

export type WebsiteMemoryInput = {
  orgName: string;
  host: string | null;
  enrichment: unknown;
  shape?: string | null;
};

export type WebsiteMemory = { company: string; ops: string; fallback: boolean };

export class WebsiteMemoryConfigError extends Error {
  constructor(public readonly status: number) {
    super(`model call rejected as non-retryable (${status})`);
    this.name = "WebsiteMemoryConfigError";
  }
}

function parseEnrichment(enrichment: unknown): z.infer<typeof EnrichmentResultSchema> | null {
  if (!enrichment) return null;
  const parsed = EnrichmentResultSchema.safeParse(enrichment);
  return parsed.success ? parsed.data : null;
}

export function buildWebsiteMemoryPrompt(input: WebsiteMemoryInput): { system: string; user: string } {
  const enrichment = parseEnrichment(input.enrichment);
  const block = enrichment ? buildEnrichmentBlock(enrichment) : "";
  const hasEnrichment = block !== "";
  const user = `Operator profile:
- Org name: ${input.orgName}
- Website: ${input.host ?? "(none)"}
${block}

Now write the 2 memory docs (company, ops) in their voice.`;
  return { system: TWO_DOC_SYSTEM_PROMPT + (hasEnrichment ? ENRICHMENT_SYSTEM_SECTION : ""), user };
}

export function buildWebsiteFallbackMemory(input: WebsiteMemoryInput): { company: string; ops: string } {
  const enrichment = parseEnrichment(input.enrichment);
  const shape = (input.shape ?? "").trim() || "company";
  const description =
    enrichment?.status === "ok" && enrichment.description
      ? sanitizeFetchedContent(enrichment.description).trim().slice(0, 1500)
      : "";
  const company = [
    `# Company\n\nWe are ${input.orgName}${input.host ? ` (${input.host})` : ""}.`,
    description ? `From our website:\n\n${description}` : "",
    "GTM motion: not specified yet - operator to confirm.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { company, ops: placeholderBody("ops", shape) };
}

async function callOnce(system: string, user: string): Promise<z.infer<typeof TwoDocSchema> | null> {
  const resp = await createMessageWithFailover(
    {
      model: DEFAULT_MODEL,
      max_tokens: 2500,
      temperature: 0.2,
      system: [cachedSystemBlock(system)],
      messages: [{ role: "user", content: user }],
    },
    { signal: AbortSignal.timeout(60_000) },
  );
  const raw = resp.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  const match = raw.match(MEMORY_BLOCK_RE);
  if (!match) return null;
  try {
    return TwoDocSchema.parse(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

export async function generateWebsiteMemory(input: WebsiteMemoryInput): Promise<WebsiteMemory> {
  const { system, user } = buildWebsiteMemoryPrompt(input);
  for (let attempt = 1; attempt <= 2; attempt++) {
    let parsed: z.infer<typeof TwoDocSchema> | null;
    try {
      parsed = await callOnce(system, user);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (typeof status === "number" && [401, 403, 404].includes(status)) {
        throw new WebsiteMemoryConfigError(status);
      }
      break;
    }
    if (parsed) return { ...parsed, fallback: false };
  }
  return { ...buildWebsiteFallbackMemory(input), fallback: true };
}
