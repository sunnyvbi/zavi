
export const MAX_PARENTS = 32;

export const PG_ANCESTORS_SQL = `WITH RECURSIVE anc AS (
   SELECT i.inhrelid AS child, i.inhparent AS parent
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
   UNION
   SELECT a.child, i.inhparent FROM anc a JOIN pg_inherits i ON i.inhrelid = a.parent
 )
 SELECT ch.relname AS child,
        array_agg(DISTINCT CASE WHEN ns.nspname = 'public' THEN p.relname ELSE ns.nspname || '.' || p.relname END) AS parents
   FROM anc a
   JOIN pg_class ch ON ch.oid = a.child
   JOIN pg_class p ON p.oid = a.parent
   JOIN pg_namespace ns ON ns.oid = p.relnamespace
  GROUP BY ch.relname`;

export type AncestorRow = { child: string; parents: string[] | null };

export function ancestorsMap(rows: AncestorRow[]): Map<string, string[]> {
  return new Map(rows.map((r) => [r.child, [...new Set(r.parents ?? [])].sort()]));
}

export function capWithAncestors(ranked: string[], cap: number, ancestors: ReadonlyMap<string, string[]>, listed: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const kept = new Set<string>();
  for (const name of ranked) {
    if (out.length >= cap) break;
    if (kept.has(name)) continue;
    const parents = ancestors.get(name) ?? [];
    if (parents.length > MAX_PARENTS) continue;
    if (parents.some((p) => !listed.has(p))) continue;
    const missing = parents.filter((p) => !kept.has(p)).sort((a, b) => (ancestors.get(a)?.length ?? 0) - (ancestors.get(b)?.length ?? 0));
    if (out.length + missing.length + 1 > cap) continue;
    for (const p of [...missing, name]) {
      kept.add(p);
      out.push(p);
    }
  }
  return out;
}
