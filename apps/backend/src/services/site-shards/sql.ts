
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function uuidLit(v: unknown): string {
  if (!isUuid(v)) throw new Error("sql: not a uuid");
  return `'${v}'::uuid`;
}

export function textLit(v: unknown): string {
  if (typeof v !== "string") throw new Error("sql: not a string");
  if (v.includes("\u0000")) throw new Error("sql: NUL in string");
  return `'${v.replace(/'/g, "''")}'`;
}

export function jsonLit(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) throw new Error("sql: value is not JSON");
  return `${textLit(s)}::jsonb`;
}

export function nameLit(v: unknown): string {
  if (typeof v !== "string" || !NAME_RE.test(v)) throw new Error("sql: invalid name");
  return `'${v}'`;
}

export function intLit(v: unknown): string {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error("sql: not an integer");
  return String(v);
}

export function publishReserveSql(site_id: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("publishReserveSql: invalid generation");
  const s = uuidLit(site_id);
  return `begin;
set local statement_timeout = '60s';
insert into zsite.site_fences as f (site_id, applied_generation) values (${s}, ${generation})
  on conflict (site_id) do update set applied_generation = excluded.applied_generation, updated_at = now()
  where f.applied_generation < excluded.applied_generation;
commit;`;
}

export function publishFenceSql(site_id: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("publishFenceSql: invalid generation");
  const s = uuidLit(site_id);
  return `do $zavi_fence$
begin
  update zsite.site_fences set updated_at = now()
   where site_id = ${s} and applied_generation = ${generation};
  if not found then
    raise exception 'zavi_refused {"code":"lease_lost"}';
  end if;
end $zavi_fence$;`;
}

export function publishFenceOnlySql(site_id: string, generation: number): string {
  return ["begin;", "set local statement_timeout = '60s';", publishFenceSql(site_id, generation), "commit;"].join("\n");
}

export function dollarQuote(body: string, rand: () => string = () => Math.random().toString(36).slice(2, 10)): string {
  for (let i = 0; i < 16; i++) {
    const tag = `$z${rand().replace(/[^a-z0-9]/g, "")}$`;
    if (tag.length > 3 && !body.includes(tag)) return `${tag}${body}${tag}`;
  }
  throw new Error("sql: could not choose a dollar-quote tag");
}
