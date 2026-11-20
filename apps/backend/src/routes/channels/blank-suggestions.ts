import type { Request, Response } from "express";
import { z } from "zod";
import { isChannelSlug } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { tenantClient } from "@/services/tenant-client";
import { createMessageWithFailover, DEFAULT_FAST_MODEL, cachedSystemBlock } from "@/services/anthropic";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { extractJsonObject } from "@/services/llm/extract-json";

const Params = z.object({ slug: z.string().min(1).max(64), id: z.string().uuid() });
const Body = z.object({
  blanks: z
    .array(z.object({ blank: z.string().min(3).max(300), label: z.string().max(200).optional() }))
    .min(1)
    .max(12),
});

const FACT_KEYS = ["company_name", "what_we_sell", "who_we_serve", "domain", "country", "competitors"];

export const BLANK_SUGGESTIONS_PROMPT = `You fill gaps in a channel card that a founder must complete before using it.

For every gap, give the one answer with the highest expected return on ad spend for this business: the most qualified people at the lowest waste. It is shown to the founder as the example inside the empty field.

Rules:
- Each answer is the literal value to type in the field, short (under 80 characters), with no explanation.
- Use only the business facts and the card. Never invent customers, results or numbers about the business.
- Respect what the gap asks for: a country list for locations, LinkedIn's own facet names for seniorities, industries and job titles.
- No em dashes.

Return only JSON: {"suggestions": {"<gap number>": ["answer"]}}`;

type Fact = { key: string; value_text: string | null };

export function parseSuggestions(raw: string, count: number): Record<string, string[]> {
  const parsed = extractJsonObject(raw) as { suggestions?: Record<string, unknown> } | null;
  const out: Record<string, string[]> = {};
  const map = parsed?.suggestions;
  if (!map || typeof map !== "object") return out;
  for (let i = 0; i < count; i += 1) {
    const list = map[String(i)];
    if (!Array.isArray(list)) continue;
    const clean = [...new Set(list.filter((v): v is string => typeof v === "string").map((v) => v.replace(/\s+/g, " ").trim()).filter((v) => v && v.length <= 120))].slice(0, 3);
    if (clean.length) out[String(i)] = clean;
  }
  return out;
}

export async function channelBlankSuggestions(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const params = Params.safeParse(req.params);
  if (!params.success || !isChannelSlug(params.data.slug)) {
    res.status(400).json({ error: { code: "bad_request", message: "unknown channel or card" } });
    return;
  }
  const body = Body.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: { code: "validation", message: body.error.issues[0]?.message ?? "invalid body" } });
    return;
  }
  const planRefusal = await refuseIfChannelPlanLocked(auth.tenant_id, params.data.slug);
  if (planRefusal) {
    res.status(403).json(planRefusal.body);
    return;
  }

  const db = tenantClient(auth.tenant_id);
  const [card, facts] = await Promise.all([
    db.from("channel_actions").select("id, channel_slug, title, body").eq("id", params.data.id).eq("channel_slug", params.data.slug).maybeSingle(),
    db.from("tenant_fact").select("key, value_text").in("key", FACT_KEYS),
  ]);
  if (card.error || facts.error) {
    res.status(500).json({ error: { code: "read_failed", message: "Zavi could not read this card." } });
    return;
  }
  if (!card.data) {
    res.status(404).json({ error: { code: "not_found", message: "This card is gone." } });
    return;
  }

  const row = card.data as { title: string | null; body: { step?: { body?: string; deliverable?: { content?: string } } } | null };
  const factLines = ((facts.data ?? []) as Fact[]).filter((f) => f.value_text?.trim()).map((f) => `${f.key}: ${f.value_text!.trim().slice(0, 600)}`);
  const gaps = body.data.blanks.map((b, i) => `${i}. ${b.label ? `${b.label}: ` : ""}${b.blank}`);
  const userMsg = [
    `Channel: ${params.data.slug}`,
    `Business facts:\n${factLines.length ? factLines.join("\n") : "none on file"}`,
    `Card: ${row.title ?? ""}\n${row.body?.step?.body ?? ""}`.slice(0, 2000),
    `What the card hands over:\n${(row.body?.step?.deliverable?.content ?? "").slice(0, 6000)}`,
    `Gaps:\n${gaps.join("\n")}`,
  ].join("\n\n");

  try {
    const resp = await createMessageWithFailover(
      {
        model: DEFAULT_FAST_MODEL,
        max_tokens: 600,
        system: [cachedSystemBlock(BLANK_SUGGESTIONS_PROMPT)],
        messages: [{ role: "user", content: userMsg }],
      },
      { signal: AbortSignal.timeout(30_000) },
    );
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    res.json({ suggestions: parseSuggestions(text, body.data.blanks.length) });
  } catch (e) {
    const err = e as { name?: string; status?: number };
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    res.status(timeout ? 504 : err?.status === 429 || err?.status === 529 ? 503 : 502).json({
      error: { code: "llm_failed", message: "Zavi could not suggest answers right now. Type your own." },
    });
  }
}
