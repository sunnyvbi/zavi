
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import {
  writeNote,
  type WriteNoteSource,
  type WriteNoteType,
} from "@/services/memory";

type MemoryNoteRow = {
  id: string;
  tenant_id: string;
  title: string | null;
  body_markdown: string | null;
  source: WriteNoteSource;
  source_ref: string | null;
  tags: string[] | null;
  note_type: WriteNoteType;
};

export const memoryNoteEnrichFn = inngest.createFunction(
  { id: "memory-note-enrich", retries: 2, concurrency: 4 },
  { event: "memory.note.enrich.requested" },
  async ({ event, step, logger }) => {
    const note_id = event.data.note_id;
    if (!note_id || typeof note_id !== "string") {
      logger.warn("memory-note-enrich: missing note_id in event data");
      return { status: "skip", reason: "missing_note_id" };
    }

    const res = await step.run("enrich", async () => {
      const svc = serviceClient();

      const { data: row, error } = await svc
        .from("memory_note")
        .select("id, tenant_id, title, body_markdown, source, source_ref, tags, note_type")
        .eq("id", note_id)
        .maybeSingle();
      if (error) {
        throw new Error(`memory_note read failed: ${error.message}`);
      }
      if (!row) {
        return { status: "skip", reason: "note_not_found" } as const;
      }

      const note = row as MemoryNoteRow;
      if (!note.body_markdown) {
        return { status: "skip", reason: "empty_body" } as const;
      }

      const result = await writeNote(note.tenant_id, {
        id: note.id,
        title: note.title ?? "",
        body_markdown: note.body_markdown,
        source: note.source,
        source_ref: note.source_ref ?? undefined,
        tags: note.tags ?? [],
        note_type: note.note_type,
      });
      return {
        status: "ok" as const,
        chunks: result.chunks,
        entities: result.entities,
      };
    });

    logger.info(
      `memory-note-enrich note=${note_id} status=${res.status}` +
        (res.status === "ok" ? ` chunks=${res.chunks} entities=${res.entities}` : ` reason=${res.reason}`),
    );
    return res;
  },
);
