
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { getAnthropic, DEFAULT_FAST_MODEL, cachedSystemBlock } from "@/services/anthropic";

const Body = z.object({
  current_body: z.string().min(1),
  use_case: z.string().min(1).max(2000),
});

const SYSTEM_PROMPT = `You rewrite Praxis agent prompts for operators.

Input: an existing agent.md body + the operator's plain-English description of how they want it adjusted.

Output: ONE rewritten agent.md body (markdown only, no frontmatter, no explanation, no fenced code-block wrapper). Preserve the agent's core role; tune the priorities, tone, and surface-area to match the operator's use case.

Hard rules:
- Keep the structure (headings, sections) of the original where possible. Operators read diff views; minimal-diff edits are easier to review.
- Don't invent new sections without strong reason.
- Don't add tools or change the agent's identity.
- Use the operator's voice when describing operating priorities (e.g. "we" not "the company").
- Output ONLY the rewritten body. No prose around it.`;

export async function agentAiAssist(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body);
  } catch (e) {
    res.status(400).json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const userMsg = `Current body:
\`\`\`markdown
${body.current_body}
\`\`\`

Operator's use case / desired adjustment:
${body.use_case}

Rewrite the body now.`;

  try {
    const anthropic = getAnthropic();
    const resp = await anthropic.messages.create(
      {
        model: DEFAULT_FAST_MODEL,
        max_tokens: 4096,
        system: [cachedSystemBlock(SYSTEM_PROMPT)],
        messages: [{ role: "user", content: userMsg }],
      },
      { signal: AbortSignal.timeout(60_000) },
    );
    const draft = resp.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    if (!draft) {
      res.status(502).json({ error: { code: "empty_draft", message: "AI returned no body" } });
      return;
    }
    res.json({
      ok: true,
      drafted_body: draft,
      tokens: resp.usage.input_tokens + resp.usage.output_tokens,
    });
  } catch (e) {
    const err = e as { name?: string; message?: string; status?: number };
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      res.status(504).json({ error: { code: "llm_timeout", message: "AI assist call timed out" } });
      return;
    }
    res.status(502).json({
      error: { code: "anthropic_upstream", message: err?.message ?? "anthropic SDK error", status: err?.status },
    });
  }
}
