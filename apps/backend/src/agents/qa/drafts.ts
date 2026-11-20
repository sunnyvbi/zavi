
import { z } from "zod";

export const draftItemSchema = z.object({
  index: z.number().int().min(1),
  title: z.string().min(3).max(200),
  role: z.enum(["guest", "host", "public"]),
  nl_spec: z.object({
    steps: z.array(z.string().min(1)).min(1).max(20),
    expected_outcome: z.string().min(3).max(500),
    preconditions: z.array(z.string()).max(10).default([]),
  }),
  tags: z.array(z.string().min(1).max(40)).max(10).default([]),
});
export const draftsSchema = z.array(draftItemSchema).min(1).max(20);
export type QaDraft = z.infer<typeof draftItemSchema>;

const DRAFTS_RE = /<drafts>([\s\S]*?)<\/drafts>/;

export function extractDrafts(rawText: string): QaDraft[] | null {
  const m = rawText.match(DRAFTS_RE);
  if (!m) return null;
  let json: unknown;
  try {
    const inner = m[1]
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    json = JSON.parse(inner);
  } catch {
    return null;
  }
  const parsed = draftsSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
