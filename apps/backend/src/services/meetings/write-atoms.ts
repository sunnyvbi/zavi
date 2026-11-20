
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

export const meetingAtomBody = z.object({
  meeting_bot_id: z.string().uuid(),
  meeting_date: z.string(),
  title: z.string().default(""),
  atoms: z
    .array(
      z.object({
        atom_type: z.string().min(1).max(32),
        title: z.string().min(1).max(200),
        body: z.string().max(2000).default(""),
        owner: z.string().max(120).nullish(),
        confidence: z.string().max(16).default("medium"),
        source_excerpt: z.string().max(600).default(""),
      }),
    )
    .min(1)
    .max(20),
});

export type WriteMeetingAtomsResult = { ok: true; written: number } | { ok: false; written: number; error: string };

export async function writeMeetingAtomsToBrain(
  svc: SupabaseClient,
  tenant_id: string,
  body: unknown,
  opts: { approvedBy: "operator" | "auto" },
): Promise<WriteMeetingAtomsResult> {
  const parsed = meetingAtomBody.safeParse(body);
  if (!parsed.success) {
    return { ok: false, written: 0, error: `memory.write_meeting_atoms bad body: ${parsed.error.message.slice(0, 300)}` };
  }
  const { writeNote } = await import("@/services/memory");
  const provenance = opts.approvedBy === "operator" ? "reviewed + approved by operator" : "saved automatically from the meeting";
  let written = 0;
  for (const a of parsed.data.atoms) {
    try {
      await writeNote(tenant_id, {
        title: `[standup ${parsed.data.meeting_date}] ${a.title}`,
        body_markdown: [
          a.body || a.title,
          a.owner ? `\nOwner: ${a.owner}` : "",
          a.source_excerpt ? `\n> ${a.source_excerpt}` : "",
          `\n(confidence: ${a.confidence}; ${provenance})`,
        ].join("\n"),
        note_type: "tenant_reference",
        source: "meeting_distill",
        source_ref: `meeting:${parsed.data.meeting_bot_id}`,
        tags: ["standup", a.atom_type],
      });
      written += 1;
    } catch (e) {
      return {
        ok: false,
        written,
        error: `writeNote failed after ${written}/${parsed.data.atoms.length}: ${(e as Error).message}`,
      };
    }
  }
  const { error } = await svc
    .from("meeting_atoms")
    .update({ status: "approved" })
    .eq("tenant_id", tenant_id)
    .eq("bot_id", parsed.data.meeting_bot_id)
    .eq("memory_class", "canonical")
    .eq("status", "pending_review");
  if (error) return { ok: false, written, error: `marking facts approved failed: ${error.message}` };
  return { ok: true, written };
}
