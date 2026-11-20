import type { AgentThreadRow } from "./types";

export function searchThreads<T extends AgentThreadRow>(rows: T[] | undefined, query: string): T[] {
  const q = query.trim().toLowerCase();
  return (rows ?? []).filter((row) => !q || (row.title ?? "").toLowerCase().includes(q));
}
