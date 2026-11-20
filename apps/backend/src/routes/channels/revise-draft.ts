
import type { Request, Response } from "express";
import { z } from "zod";
import { xWeightedLength } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { createMessageWithFailover, DEFAULT_FAST_MODEL, cachedSystemBlock } from "@/services/anthropic";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";

const X_LIMIT = 280;

const Params = z.object({ slug: z.literal("x_organic") });
const Body = z.object({
  text: z.string().min(1).max(4000),
  thread: z.array(z.string().max(4000)).max(24).nullable().optional(),
  instruction: z.string().min(2).max(1000),
});

const SYSTEM_PROMPT = `You revise one draft post for X (Twitter) according to the account owner's instruction.

Return ONLY the revised post text. No preamble, no quotes around it, no explanation, no markdown.

Rules:
- Apply the instruction and change nothing it did not ask for. Keep the author's voice, claims and links.
- Every part must fit X's limit of ${X_LIMIT} characters, where any URL counts as 23.
- If the draft is a thread, the parts are separated by a line containing only ---. Return the same number of parts, separated the same way, unless the instruction asks for more or fewer.
- A marker like [CONFIRM: ...] flags a fact the owner has not verified. Keep it exactly as written unless the instruction supplies the fact.
- Never invent numbers, customers, results or quotes.
- No em dashes.`;

export function xLength(text: string): number {
  return xWeightedLength(text).length;
}

export async function channelReviseDraft(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!Params.safeParse(req.params).success) {
    res.status(400).json({ error: { code: "bad_channel", message: "unknown channel" } });
    return;
  }
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "validation", message: parsed.error.issues[0]?.message ?? "invalid body" } });
    return;
  }
  const planRefusal = await refuseIfChannelPlanLocked(auth.tenant_id, "x_organic");
  if (planRefusal) {
    res.status(403).json(planRefusal.body);
    return;
  }
  const { text, thread, instruction } = parsed.data;

  const parts = [text, ...(thread ?? [])];
  const userMsg = `The draft:\n${parts.join("\n---\n")}\n\nThe instruction:\n${instruction}\n\nReturn the revised post now.`;

  try {
    const resp = await createMessageWithFailover(
      {
        model: DEFAULT_FAST_MODEL,
        max_tokens: 1500,
        system: [cachedSystemBlock(SYSTEM_PROMPT)],
        messages: [{ role: "user", content: userMsg }],
      },
      { signal: AbortSignal.timeout(30_000) },
    );
    const out = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const revised = out.split(/\n\s*---\s*\n/).map((x) => x.trim()).filter(Boolean);
    if (revised.length === 0) {
      res.status(502).json({ error: { code: "empty_revision", message: "AI edit returned nothing. Try again, or edit by hand." } });
      return;
    }
    res.json({
      ok: true,
      text: revised[0],
      thread: revised.length > 1 ? revised.slice(1) : null,
      over_limit: revised.some((part) => xLength(part) > X_LIMIT),
    });
  } catch (e) {
    const err = e as { name?: string; message?: string; status?: number };
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    const busy = err?.status === 429 || err?.status === 529;
    res.status(timeout ? 504 : busy ? 503 : 502).json({
      error: timeout
        ? { code: "llm_timeout", message: "AI edit timed out. Try again, or edit by hand." }
        : busy
          ? { code: "llm_busy", message: "Zavi's AI is busy right now. Try again in a minute, or edit by hand." }
          : { code: "llm_upstream", message: "AI edit failed. Try again, or edit by hand." },
    });
  }
}
