
import { createHash } from "node:crypto";

const SEP = String.fromCharCode(31);

export function normalizeForHash(body: string): string {
  return (body ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

const PER_AGENT_DEDUP_NOTE_TYPES = new Set(["agent_procedural"]);

export function contentHash(
  tenant_id: string,
  note_type: string,
  body: string,
  agent_slug?: string | null,
  dedup_key?: string | null,
): string {
  const norm = normalizeForHash(body);
  const parts = ["v1", tenant_id, note_type || "untyped", norm];
  if (PER_AGENT_DEDUP_NOTE_TYPES.has(note_type) && agent_slug) {
    parts.push(agent_slug);
  }
  if (dedup_key) parts.push(`dedup_key:${dedup_key}`);
  return createHash("sha256").update(parts.join(SEP)).digest("hex");
}
