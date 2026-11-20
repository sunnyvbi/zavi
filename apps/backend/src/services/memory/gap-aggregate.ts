
import { createHash } from "node:crypto";

export type GapEpisode = {
  tenant_id: string;
  agent_slug: string;
  status: string;
  created_at: string;
  question: string;
};

export type GapGroup = {
  tenant_id: string;
  hash: string;
  question: string;
  count: number;
  last_seen: string;
  agents: string[];
  statuses: string[];
};

export function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 500);
}

export function questionHash(tenant_id: string, q: string): string {
  return createHash("sha256")
    .update(`${tenant_id} ${normalizeQuestion(q)}`)
    .digest("hex")
    .slice(0, 32);
}

export function aggregateGaps(eps: GapEpisode[], minCount: number): GapGroup[] {
  const map = new Map<string, GapGroup>();
  for (const e of eps) {
    if (!e.question || !e.question.trim()) continue;
    const hash = questionHash(e.tenant_id, e.question);
    const key = `${e.tenant_id}:${hash}`;
    const g =
      map.get(key) ??
      ({
        tenant_id: e.tenant_id,
        hash,
        question: e.question,
        count: 0,
        last_seen: e.created_at,
        agents: [],
        statuses: [],
      } satisfies GapGroup);
    g.count += 1;
    if (e.created_at > g.last_seen) g.last_seen = e.created_at;
    if (e.agent_slug && !g.agents.includes(e.agent_slug)) g.agents.push(e.agent_slug);
    if (e.status && !g.statuses.includes(e.status)) g.statuses.push(e.status);
    map.set(key, g);
  }
  return Array.from(map.values())
    .filter((g) => g.count >= minCount)
    .sort((a, b) => b.count - a.count);
}
