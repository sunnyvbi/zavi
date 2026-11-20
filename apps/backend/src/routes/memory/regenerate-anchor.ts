
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { regenerateAnchor } from "@/services/memory/generate-anchors";
import { MEMORY_SLUGS, type MemoryDocSlug } from "@/services/memory/loader";

const VALID_SLUGS = new Set<string>(MEMORY_SLUGS as readonly string[]);

export async function memoryRegenerateAnchor(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = req.body as { slug?: unknown; refineInstruction?: unknown };
  const slug = typeof body.slug === "string" ? body.slug : "";
  if (!VALID_SLUGS.has(slug)) {
    res.status(400).json({
      error: {
        code: "bad_slug",
        message: `slug must be one of: ${Array.from(VALID_SLUGS).join(", ")}`,
      },
    });
    return;
  }

  const refineInstruction =
    typeof body.refineInstruction === "string" && body.refineInstruction.trim().length > 0
      ? body.refineInstruction.trim().slice(0, 500)
      : undefined;

  try {
    const result = await regenerateAnchor({
      tenant_id: auth.tenant_id,
      slug: slug as MemoryDocSlug,
      refineInstruction,
    });
    res.json({
      ok: true,
      slug: result.slug,
      note_id: result.note_id,
      body_markdown: result.body_markdown,
      key_facts: result.key_facts,
      chunks: result.chunks,
      tokens: result.tokens,
    });
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string };
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      res.status(504).json({
        error: { code: "llm_timeout", message: "Anthropic call timed out after 60s" },
      });
      return;
    }
    res.status(500).json({
      error: { code: "regenerate_failed", message: err?.message ?? "regenerate failed" },
    });
  }
}
