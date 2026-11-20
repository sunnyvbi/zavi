
import { createHash } from "node:crypto";
import type { ShardSql } from "./contract";
import { canonical } from "./collections-plan";
import { intLit, jsonLit, nameLit, textLit, uuidLit, isUuid } from "./sql";

export const EXPORT_FORMAT_V2 = "zavi-site-export";
export const EXPORT_V2_PAGE = 500;

const TS = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export type ExportCounts = { collections: number; identities: number; members: number; files: number; records: number; audit: number };
export type ExportLine =
  | { t: "head"; format: string; v: 2; site_id: string; project_ref: string }
  | { t: "contract"; [k: string]: unknown }
  | { t: "quota"; [k: string]: unknown }
  | { t: "collection"; [k: string]: unknown }
  | { t: "identity"; identity: Record<string, unknown>; auth_user: Record<string, unknown> | null; auth_identities: Record<string, unknown>[] }
  | { t: "member"; [k: string]: unknown }
  | { t: "file"; name: string }
  | { t: "audit"; [k: string]: unknown }
  | { t: "record"; [k: string]: unknown }
  | { t: "end"; counts: ExportCounts; sha256: string };

export function hashProjection(line: ExportLine): unknown {
  if (line.t === "identity") {
    const u = line.auth_user ?? {};
    return {
      t: "identity",
      identity: line.identity,
      auth_user: line.auth_user
        ? { id: u.id, email: u.email, encrypted_password: u.encrypted_password ?? null, email_confirmed_at: u.email_confirmed_at ?? null }
        : null,
      auth_identities: line.auth_identities.length,
    };
  }
  return line;
}

export class ExportHasher {
  private h = createHash("sha256");
  readonly counts: ExportCounts = { collections: 0, identities: 0, members: 0, files: 0, records: 0, audit: 0 };
  add(line: ExportLine): void {
    if (line.t === "head" || line.t === "end") return;
    this.h.update(canonical(hashProjection(line)));
    this.h.update("\n");
    if (line.t === "collection") this.counts.collections++;
    else if (line.t === "identity") this.counts.identities++;
    else if (line.t === "member") this.counts.members++;
    else if (line.t === "file") this.counts.files++;
    else if (line.t === "record") this.counts.records++;
    else if (line.t === "audit") this.counts.audit++;
  }
  digest(): string {
    return this.h.digest("hex");
  }
}

export function referenceOrder(cols: Array<{ name: string; references?: unknown }>): string[] {
  const deps = new Map<string, string[]>();
  for (const c of cols) {
    const r = c.references && typeof c.references === "object" ? (c.references as Record<string, { collection?: unknown }>) : {};
    deps.set(c.name, Object.values(r).map((x) => String(x?.collection ?? "")).filter((n) => n && n !== c.name));
  }
  const out: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (n: string, depth: number) => {
    if (state.get(n) === 2 || !deps.has(n)) return;
    if (state.get(n) === 1 || depth > 64) throw new Error(`export: reference cycle at ${n}`);
    state.set(n, 1);
    for (const d of [...(deps.get(n) ?? [])].sort()) visit(d, depth + 1);
    state.set(n, 2);
    out.push(n);
  };
  for (const n of [...deps.keys()].sort()) visit(n, 0);
  return out;
}

export type ExportSource = {
  sql: ShardSql;
  project_ref: string;
  site_id: string;
  listFiles: () => Promise<string[]>;
};

export async function* exportSiteV2Lines(src: ExportSource): AsyncGenerator<ExportLine> {
  const { sql, project_ref: ref, site_id } = src;
  const s = uuidLit(site_id);
  const hasher = new ExportHasher();
  const emit = (l: ExportLine) => (hasher.add(l), l);
  yield { t: "head", format: EXPORT_FORMAT_V2, v: 2, site_id, project_ref: ref };

  const contract = (await sql.query(
    ref,
    `select schema_version, roles, capabilities, actions, aggregates from zsite.site_contracts where site_id = ${s}`,
  )) as Array<Record<string, unknown>>;
  if (contract[0]) yield emit({ t: "contract", ...contract[0] });
  const quota = (await sql.query(
    ref,
    `select max_records, max_bytes, max_writes_per_min, max_record_bytes from zsite.quotas where site_id = ${s}`,
  )) as Array<Record<string, unknown>>;
  if (quota[0]) yield emit({ t: "quota", ...Object.fromEntries(Object.entries(quota[0]).map(([k, v]) => [k, Number(v)])) });

  const cols = (await sql.query(
    ref,
    `select name, kind, rules, schema, fields, indexes, recipient, uniques, states, "references",
            archived_at is not null as archived
       from zsite.collections where site_id = ${s} order by name collate "C"`,
  )) as Array<Record<string, unknown> & { name: string }>;
  for (const c of cols) yield emit({ t: "collection", ...c });

  const hasAuthIdentities =
    ((await sql.query(ref, "select to_regclass('auth.identities') is not null as p")) as Array<{ p?: boolean }>)[0]?.p === true;
  let after: string | null = null;
  for (;;) {
    const page = (await sql.query(
      ref,
      `select i.email_norm, i.auth_user_id::text as auth_user_id, i.alias, i.state,
              (select to_jsonb(u) from auth.users u where u.id = i.auth_user_id) as auth_user,
              ${hasAuthIdentities
                ? `(select coalesce(jsonb_agg(to_jsonb(ai) order by ai.provider), '[]'::jsonb)
                      from auth.identities ai where ai.user_id = i.auth_user_id)`
                : `'[]'::jsonb`} as auth_identities
         from zsite.identities i
        where i.site_id = ${s} ${after ? `and i.auth_user_id > ${uuidLit(after)}` : ""}
        order by i.auth_user_id limit ${intLit(EXPORT_V2_PAGE)}`,
    )) as Array<Record<string, unknown>>;
    if (!page.length) break;
    for (const r of page) {
      const { auth_user, auth_identities, ...identity } = r;
      yield emit({
        t: "identity",
        identity,
        auth_user: (auth_user as Record<string, unknown>) ?? null,
        auth_identities: Array.isArray(auth_identities) ? (auth_identities as Record<string, unknown>[]) : [],
      });
    }
    after = String(page[page.length - 1].auth_user_id);
  }

  const members = (await sql.query(
    ref,
    `select user_id::text as user_id, role, status, ${TS("created_at")} as created_at
       from zsite.members where site_id = ${s} order by user_id`,
  )) as Array<Record<string, unknown>>;
  for (const m of members) yield emit({ t: "member", ...m });

  const hasAudit = ((await sql.query(ref, "select to_regclass('zsite_auth.member_audit') is not null as p")) as Array<{ p?: boolean }>)[0]?.p === true;
  if (hasAudit) {
    let afterId = 0;
    for (;;) {
      const page = (await sql.query(
        ref,
        `select id, actor_id::text as actor_id, action, target_id::text as target_id, detail, ${TS("created_at")} as created_at
           from zsite_auth.member_audit where site_id = ${s} and id > ${intLit(afterId)} order by id limit ${intLit(EXPORT_V2_PAGE)}`,
      )) as Array<Record<string, unknown>>;
      if (!page.length) break;
      for (const r of page) {
        const { id: _id, ...rest } = r;
        yield emit({ t: "audit", ...rest });
      }
      afterId = Number(page[page.length - 1].id);
    }
  }

  const files = (await src.listFiles()).filter((f) => f.startsWith(`${site_id}/`)).sort();
  for (const name of files) yield emit({ t: "file", name });

  for (const collection of referenceOrder(cols)) {
    let afterId: string | null = null;
    for (;;) {
      const page = (await sql.query(
        ref,
        `select collection, id::text as id, owner_id::text as owner_id, data, ${TS("created_at")} as created_at,
                ${TS("updated_at")} as updated_at, state, recipient_u1::text as recipient_u1
           from zsite.records
          where site_id = ${s} and collection = ${nameLit(collection)} ${afterId ? `and id > ${uuidLit(afterId)}` : ""}
          order by id limit ${intLit(EXPORT_V2_PAGE)}`,
      )) as Array<Record<string, unknown>>;
      if (!page.length) break;
      for (const r of page) yield emit({ t: "record", ...r });
      afterId = String(page[page.length - 1].id);
    }
  }
  yield { t: "end", counts: { ...hasher.counts }, sha256: hasher.digest() };
}

export async function* exportSiteV2(src: ExportSource): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  for await (const line of exportSiteV2Lines(src)) yield enc.encode(`${JSON.stringify(line)}\n`);
}

export async function hashSite(src: ExportSource): Promise<{ counts: ExportCounts; sha256: string }> {
  for await (const line of exportSiteV2Lines(src)) if (line.t === "end") return { counts: line.counts, sha256: line.sha256 };
  throw new Error("export ended without an end line");
}

export async function* ndjsonLines(dump: AsyncIterable<Uint8Array>, maxLine = 8 * 1024 * 1024): AsyncGenerator<ExportLine> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of dump) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l.trim()) yield JSON.parse(l) as ExportLine;
    }
    if (buf.length > maxLine) throw new Error("import: line too long");
  }
  buf += dec.decode();
  if (buf.trim()) yield JSON.parse(buf) as ExportLine;
}

export interface SiteImporter {
  available(): boolean;
  import(input: {
    tenant_id: string;
    site_id: string;
    project_ref: string;
    dump: AsyncIterable<Uint8Array>;
  }): Promise<{ records: number; files: number; members: number; sha256: string }>;
}

export type FileCopier = (input: { source_project_ref: string; name: string; target_project_ref: string }) => Promise<void>;

const COL_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const ident = (n: string) => {
  if (!COL_RE.test(n)) throw new Error("import: unexpected column name");
  return `"${n}"`;
};

async function insertableColumns(sql: ShardSql, ref: string, table: "users" | "identities"): Promise<string[]> {
  const rows = (await sql.query(
    ref,
    `select column_name from information_schema.columns
      where table_schema = 'auth' and table_name = ${textLit(table)} and is_generated = 'NEVER'
        and not (is_identity = 'YES' and identity_generation = 'ALWAYS')
      order by ordinal_position`,
  )) as Array<{ column_name?: string }>;
  return rows.map((r) => String(r.column_name ?? "")).filter((c) => COL_RE.test(c));
}

export function createSqlSiteImporter(deps: { sql: ShardSql; copyFile: FileCopier | null; batch?: number }): SiteImporter {
  const batchSize = deps.batch ?? 200;
  return {
    available: () => true,
    async import(input) {
      const { sql } = deps;
      const ref = input.project_ref;
      if (!isUuid(input.site_id)) throw new Error("import: bad site id");
      const s = uuidLit(input.site_id);
      const hasher = new ExportHasher();
      let userCols: string[] | null = null;
      let identCols: string[] | null = null;
      let ended: Extract<ExportLine, { t: "end" }> | null = null;
      let sourceRef = "";
      let records: Array<Record<string, unknown>> = [];
      let identities: Array<Extract<ExportLine, { t: "identity" }>> = [];
      let members: Array<Record<string, unknown>> = [];
      const flushIdentities = async () => {
        if (!identities.length) return;
        userCols ??= await insertableColumns(sql, ref, "users");
        const users = identities.map((l) => l.auth_user).filter((u): u is Record<string, unknown> => !!u);
        if (users.length) {
          const cl = userCols.map(ident).join(", ");
          await sql.query(
            ref,
            `insert into auth.users (${cl}) select ${cl} from jsonb_populate_recordset(null::auth.users, ${jsonLit(users)})
             on conflict (id) do nothing`,
          );
        }
        const ais = identities.flatMap((l) => l.auth_identities);
        if (ais.length) {
          identCols ??= await insertableColumns(sql, ref, "identities");
          const cl = identCols.map(ident).join(", ");
          await sql.query(
            ref,
            `insert into auth.identities (${cl}) select ${cl} from jsonb_populate_recordset(null::auth.identities, ${jsonLit(ais)})
             on conflict do nothing`,
          );
        }
        await sql.query(
          ref,
          `insert into zsite.identities (site_id, email_norm, auth_user_id, alias, state)
           select ${s}, x.email_norm, x.auth_user_id, x.alias, x.state
             from jsonb_to_recordset(${jsonLit(identities.map((l) => l.identity))})
                  as x(email_norm text, auth_user_id uuid, alias text, state text)
           on conflict do nothing`,
        );
        identities = [];
      };
      const flushMembers = async () => {
        if (!members.length) return;
        await sql.query(
          ref,
          `insert into zsite.members (site_id, user_id, role, status, created_at)
           select ${s}, x.user_id, x.role, x.status, x.created_at
             from jsonb_to_recordset(${jsonLit(members)}) as x(user_id uuid, role text, status text, created_at timestamptz)
           on conflict (site_id, user_id) do nothing`,
        );
        members = [];
      };
      const flushRecords = async () => {
        if (!records.length) return;
        await sql.query(
          ref,
          `insert into zsite.records (site_id, collection, id, owner_id, data, created_at, updated_at, state, recipient_u1)
           select ${s}, x.collection, x.id, x.owner_id, x.data, x.created_at, x.updated_at, x.state, x.recipient_u1
             from jsonb_to_recordset(${jsonLit(records)})
                  as x(collection text, id uuid, owner_id uuid, data jsonb, created_at timestamptz, updated_at timestamptz,
                       state text, recipient_u1 uuid)
           on conflict (site_id, collection, id) do nothing;
           -- the shard's BEFORE trigger stamps updated_at on insert; a write that
           -- changes no data keeps the value it is given, so restore the original.
           update zsite.records r set updated_at = x.updated_at
             from jsonb_to_recordset(${jsonLit(records.map((r) => ({ collection: r.collection, id: r.id, updated_at: r.updated_at })))})
                  as x(collection text, id uuid, updated_at timestamptz)
            where r.site_id = ${s} and r.collection = x.collection and r.id = x.id and r.updated_at is distinct from x.updated_at`,
        );
        records = [];
      };

      let first = true;
      for await (const line of ndjsonLines(input.dump)) {
        if (first) {
          first = false;
          if (line.t !== "head" || line.format !== EXPORT_FORMAT_V2 || line.v !== 2 || line.site_id !== input.site_id) {
            throw new Error("import: not a v2 export of this site");
          }
          if (typeof line.project_ref !== "string" || line.project_ref === ref) throw new Error("import: the export names no other source project");
          sourceRef = line.project_ref;
          await sql.query(ref, `insert into zsite.sites (site_id) values (${s}) on conflict (site_id) do nothing`);
          continue;
        }
        if (ended) throw new Error("import: data after the end line");
        hasher.add(line);
        switch (line.t) {
          case "contract": {
            const { t: _t, ...c } = line;
            await sql.query(
              ref,
              `insert into zsite.site_contracts (site_id, schema_version, roles, capabilities, actions, aggregates, updated_at)
               values (${s}, ${intLit(Number(c.schema_version) === 2 ? 2 : 1)}, ${jsonLit(c.roles ?? [])}, ${jsonLit(c.capabilities ?? [])},
                       ${jsonLit(c.actions ?? {})}, ${jsonLit(c.aggregates ?? {})}, now())
               on conflict (site_id) do nothing`,
            );
            break;
          }
          case "quota": {
            const q = line as Record<string, unknown>;
            await sql.query(
              ref,
              `insert into zsite.quotas (site_id, max_records, max_bytes, max_writes_per_min, max_record_bytes)
               values (${s}, ${intLit(Number(q.max_records))}, ${intLit(Number(q.max_bytes))}, ${intLit(Number(q.max_writes_per_min))},
                       ${intLit(Number(q.max_record_bytes))})
               on conflict (site_id) do update set max_records = excluded.max_records, max_bytes = excluded.max_bytes,
                 max_writes_per_min = excluded.max_writes_per_min, max_record_bytes = excluded.max_record_bytes`,
            );
            break;
          }
          case "collection": {
            const c = line as Record<string, unknown>;
            await sql.query(
              ref,
              `insert into zsite.collections (site_id, name, kind, rules, schema, fields, indexes, recipient, uniques, states, "references", archived_at)
               values (${s}, ${nameLit(c.name)}, ${textLit(String(c.kind))}, ${jsonLit(c.rules ?? {})}, ${jsonLit(c.schema ?? {})},
                       ${jsonLit(c.fields ?? {})}, ${jsonLit(c.indexes ?? {})}, ${c.recipient == null ? "null" : jsonLit(c.recipient)}, ${jsonLit(c.uniques ?? [])},
                       ${c.states == null ? "null" : jsonLit(c.states)}, ${jsonLit(c.references ?? {})}, ${c.archived === true ? "now()" : "null"})
               on conflict (site_id, name) do nothing`,
            );
            break;
          }
          case "identity":
            identities.push(line);
            if (identities.length >= batchSize) await flushIdentities();
            break;
          case "member":
            await flushIdentities();
            members.push(line as Record<string, unknown>);
            if (members.length >= batchSize) await flushMembers();
            break;
          case "audit": {
            await flushIdentities();
            await flushMembers();
            const a = line as Record<string, unknown>;
            await sql.query(
              ref,
              `insert into zsite_auth.member_audit (site_id, actor_id, action, target_id, detail, created_at)
               select ${s}, x.actor_id, x.action, x.target_id, x.detail, x.created_at
                 from jsonb_to_record(${jsonLit({ actor_id: a.actor_id ?? null, action: a.action, target_id: a.target_id ?? null, detail: a.detail ?? {}, created_at: a.created_at })})
                      as x(actor_id uuid, action text, target_id uuid, detail jsonb, created_at timestamptz)
                where not exists (select 1 from zsite_auth.member_audit m where m.site_id = ${s} and m.action = x.action
                                    and m.actor_id is not distinct from x.actor_id and m.target_id is not distinct from x.target_id
                                    and m.created_at = x.created_at and m.detail = x.detail)`,
            );
            break;
          }
          case "file":
            await flushIdentities();
            await flushMembers();
            if (!line.name.startsWith(`${input.site_id}/`)) throw new Error("import: file outside the site prefix");
            if (!deps.copyFile) throw new Error("import: no file copier is wired");
            await deps.copyFile({ source_project_ref: sourceRef, name: line.name, target_project_ref: ref });
            break;
          case "record": {
            await flushIdentities();
            await flushMembers();
            const { t: _t, ...r } = line;
            records.push(r);
            if (records.length >= batchSize) await flushRecords();
            break;
          }
          case "end":
            ended = line;
            break;
          default:
            throw new Error("import: unknown line");
        }
      }
      await flushIdentities();
      await flushMembers();
      await flushRecords();
      if (!ended) throw new Error("import: the export did not finish (no end line)");
      const sha256 = hasher.digest();
      if (sha256 !== ended.sha256 || canonical(hasher.counts) !== canonical(ended.counts)) {
        throw new Error("import: the stream does not match its own checksum");
      }
      return { records: hasher.counts.records, files: hasher.counts.files, members: hasher.counts.members, sha256 };
    },
  };
}
