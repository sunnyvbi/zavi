
import type { CollectionDef, ShardSql, SiteContractDef } from "./contract";
import { defValue, type SitePlan } from "./collections-plan";
import { dollarQuote, jsonLit, nameLit, publishFenceSql, textLit, uuidLit } from "./sql";

export const collectionLockKeySql = (siteLit: string, nameLiteral: string) => `zsite.manifest_lock_key(${siteLit}, ${nameLiteral})`;

export class SiteContractRefused extends Error {
  constructor(
    public readonly code: string,
    reason: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(reason);
    this.name = "SiteContractRefused";
  }
}

export function snapshotV2(cols: CollectionDef[]) {
  return [...cols]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((c) => ({
      name: c.name,
      kind: c.kind,
      rules: c.rules,
      schema: c.schema,
      fields: c.fields,
      indexes: c.indexes,
      archived: c.archived === true,
      recipient: defValue(c, "recipient"),
      uniques: defValue(c, "unique"),
      states: defValue(c, "states"),
      references: defValue(c, "references"),
    }));
}

const SNAPSHOT_SQL = (s: string) => `(select coalesce(jsonb_agg(jsonb_build_object(
    'name', name, 'kind', kind, 'rules', rules, 'schema', schema, 'fields', fields, 'indexes', indexes,
    'archived', archived_at is not null, 'recipient', coalesce(recipient, 'null'::jsonb),
    'uniques', coalesce(uniques, '[]'::jsonb), 'states', coalesce(states, 'null'::jsonb),
    'references', coalesce("references", '{}'::jsonb)) order by name collate "C"), '[]'::jsonb)
  from zsite.collections where site_id = ${s})`;

const CONTRACT_SQL = (s: string) => `(select jsonb_build_object('schema_version', schema_version, 'roles', roles,
    'capabilities', capabilities, 'actions', actions, 'aggregates', aggregates)
  from zsite.site_contracts where site_id = ${s})`;

export function contractSnapshot(c: SiteContractDef | null) {
  return c ? { schema_version: c.schema_version, roles: c.roles, capabilities: c.capabilities, actions: c.actions, aggregates: c.aggregates } : null;
}

export type RoleHolder = { user_id: string; role: string };

export function applySitePlanSql(
  site_id: string,
  plan: SitePlan,
  current: CollectionDef[],
  currentContract: SiteContractDef | null,
  holders: RoleHolder[],
  manifest_hash = "",
  generation?: number,
): string {
  const s = uuidLit(site_id);
  const touched = new Set<string>([
    ...plan.collections.add.map((c) => c.name),
    ...plan.collections.change.map((c) => c.name),
    ...plan.collections.archive,
    ...plan.backfill.references.map((r) => r.target),
    ...plan.backfill.recipients.map((r) => r.target),
    ...plan.backfill.counters.map((r) => r.collection),
  ]);
  const backfill = {
    uniques: plan.backfill.uniques,
    states: plan.backfill.states,
    references: plan.backfill.references,
    recipients: plan.backfill.recipients,
    counters: plan.backfill.counters,
    removed_roles: plan.backfill.removedRoles,
    holders: [...holders].sort((a, b) => (a.user_id + a.role < b.user_id + b.role ? -1 : 1)),
    manifest_hash,
  };
  const parts: string[] = [
    "begin;",
    "set local statement_timeout = '300s';",
    ...(generation !== undefined ? [publishFenceSql(site_id, generation)] : []),
    `select 1 from zsite.sites where site_id = ${s} for update;`,
    ...[...touched].sort().map((n) => `select pg_catalog.pg_advisory_xact_lock(${collectionLockKeySql(s, nameLit(n))});`),
    `do ${dollarQuote(`
     declare
       b jsonb := ${jsonLit(backfill)};
       r jsonb;
       v_n bigint;
       v_g bigint;
       v_f text;
     begin
       if not exists (select 1 from zsite.sites where site_id = ${s} and status = 'active') then
         raise exception 'shard_site_not_active';
       end if;
       if ${SNAPSHOT_SQL(s)} is distinct from ${jsonLit(snapshotV2(current))} then
         raise exception 'collections_changed';
       end if;
       if ${CONTRACT_SQL(s)} is distinct from ${currentContract ? jsonLit(contractSnapshot(currentContract)) : "null::jsonb"} then
         raise exception 'collections_changed';
       end if;

       -- uniqueness: the shard's key text (jsonb_build_array of the components);
       -- distinct = no key when a component is absent / JSON null.
       for r in select * from jsonb_array_elements(b->'uniques') loop
         select count(*), coalesce(sum(n), 0) into v_g, v_n from (
           select count(*) as n from (
             select (select jsonb_agg(case when r->>'nulls' = 'not_distinct' then coalesce(x.data->f.v, 'null'::jsonb)
                                           else x.data->f.v end order by f.i)::text
                       from jsonb_array_elements_text(r->'fields') with ordinality f(v, i)) as k,
                    (select bool_or(coalesce(jsonb_typeof(x.data->f.v), 'null') = 'null')
                       from jsonb_array_elements_text(r->'fields') f(v)) as has_null
               from zsite.records x
              where x.site_id = ${s} and x.collection = r->>'collection'
           ) y
           where r->>'nulls' = 'not_distinct' or not y.has_null
           group by y.k having count(*) > 1
         ) d;
         if v_g > 0 then
           raise exception 'zavi_refused %', jsonb_build_object('code', 'unique_duplicates', 'collection', r->>'collection',
             'fields', r->'fields', 'groups', v_g, 'records', v_n);
         end if;
       end loop;

       -- states: every present value must be a declared value; absent -> initial.
       for r in select * from jsonb_array_elements(b->'states') loop
         v_f := r->>'field';
         select count(*) into v_n from zsite.records x
          where x.site_id = ${s} and x.collection = r->>'collection'
            and coalesce(jsonb_typeof(x.data->v_f), 'null') <> 'null'
            and not (jsonb_typeof(x.data->v_f) = 'string' and (r->'values') ? (x.data->>v_f));
         if v_n > 0 then
           raise exception 'zavi_refused %', jsonb_build_object('code', 'invalid_states', 'collection', r->>'collection',
             'field', v_f, 'values', r->'values', 'records', v_n);
         end if;
         update zsite.records x set data = x.data || jsonb_build_object(v_f, r->>'initial')
          where x.site_id = ${s} and x.collection = r->>'collection' and coalesce(jsonb_typeof(x.data->v_f), 'null') = 'null';
       end loop;

       -- references: every non-null target must be a live record of the target collection.
       for r in select * from jsonb_array_elements(b->'references') loop
         v_f := r->>'field';
         select count(*) into v_n from zsite.records x
          where x.site_id = ${s} and x.collection = r->>'collection'
            and coalesce(jsonb_typeof(x.data->v_f), 'null') <> 'null'
            and not exists (select 1 from zsite.records t join zsite.collections tc
                               on tc.site_id = t.site_id and tc.name = t.collection and tc.archived_at is null
                             where t.site_id = ${s} and t.collection = r->>'target' and t.id::text = x.data->>v_f);
         if v_n > 0 then
           raise exception 'zavi_refused %', jsonb_build_object('code', 'broken_references', 'collection', r->>'collection',
             'field', v_f, 'target', r->>'target', 'records', v_n);
         end if;
       end loop;

       -- recipients: the target must exist and have an owner.
       for r in select * from jsonb_array_elements(b->'recipients') loop
         v_f := r->>'field';
         select count(*) into v_n from zsite.records x
          where x.site_id = ${s} and x.collection = r->>'collection'
            and not exists (select 1 from zsite.records t
                             where t.site_id = ${s} and t.collection = r->>'target' and t.id::text = x.data->>v_f
                               and t.owner_id is not null);
         if v_n > 0 then
           raise exception 'zavi_refused %', jsonb_build_object('code', 'recipient_unresolvable', 'collection', r->>'collection',
             'field', v_f, 'target', r->>'target', 'records', v_n);
         end if;
       end loop;

       -- action counters: absent -> initial, then integer within bounds.
       for r in select * from jsonb_array_elements(b->'counters') loop
         v_f := r->>'counter';
         update zsite.records x set data = x.data || jsonb_build_object(v_f, (r->>'initial')::bigint)
          where x.site_id = ${s} and x.collection = r->>'collection' and coalesce(jsonb_typeof(x.data->v_f), 'null') = 'null';
         select count(*) into v_n from zsite.records x
          where x.site_id = ${s} and x.collection = r->>'collection'
            and not (
              jsonb_typeof(x.data->v_f) = 'number'
              and (x.data->>v_f)::numeric = trunc((x.data->>v_f)::numeric)
              and (x.data->>v_f)::numeric >= (r->'bounds'->>'min')::numeric
              and case when r->'bounds' ? 'maxField' then
                         jsonb_typeof(x.data->(r->'bounds'->>'maxField')) = 'number'
                         and (x.data->>v_f)::numeric <= (x.data->>(r->'bounds'->>'maxField'))::numeric
                       else (x.data->>v_f)::numeric <= (r->'bounds'->>'max')::numeric end);
         if v_n > 0 then
           raise exception 'zavi_refused %', jsonb_build_object('code', 'action_bounds', 'action', r->>'action',
             'collection', r->>'collection', 'field', v_f, 'records', v_n);
         end if;
       end loop;

       -- removed roles: demote exactly the audited holders (else re-plan).
       if jsonb_array_length(b->'removed_roles') > 0 then
         if (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role)
                                         order by (m.user_id::text || m.role) collate "C"), '[]'::jsonb)
               from zsite.members m
              where m.site_id = ${s} and m.role in (select jsonb_array_elements_text(b->'removed_roles')))
            is distinct from (b->'holders') then
           raise exception 'collections_changed';
         end if;
         update zsite.members m set role = 'user'
          where m.site_id = ${s} and m.role in (select jsonb_array_elements_text(b->'removed_roles'));
         get diagnostics v_n = row_count;
         if v_n <> jsonb_array_length(b->'holders') then
           raise exception 'collections_changed';
         end if;
         -- The audit, in THIS transaction, in the shard's own member audit (K2's
         -- zsite_auth.member_audit, append-only): one set_role row per demotion.
         if to_regclass('zsite_auth.member_audit') is null then
           raise exception 'member_audit_unavailable';
         end if;
         execute 'insert into zsite_auth.member_audit (site_id, actor_id, action, target_id, detail)
                  select $1, null, ''set_role'', (h->>''user_id'')::uuid,
                         jsonb_build_object(''from'', h->>''role'', ''to'', ''user'',
                                            ''reason'', ''role_removed_from_manifest'', ''manifest_hash'', $2)
                    from jsonb_array_elements($3) h'
           using ${s}, b->>'manifest_hash', b->'holders';
       end if;
     end`)};`,
  ];
  const nullable = (v: unknown) => (v == null ? "null" : jsonLit(v));
  const v2cols = (c: CollectionDef) =>
    `${nullable(defValue(c, "recipient"))}, ${jsonLit(defValue(c, "unique"))}, ${nullable(defValue(c, "states"))}, ${jsonLit(defValue(c, "references"))}`;
  for (const c of plan.collections.add) {
    parts.push(
      `insert into zsite.collections (site_id, name, kind, rules, schema, fields, indexes, recipient, uniques, states, "references")
       values (${s}, ${nameLit(c.name)}, ${textLit(c.kind)}, ${jsonLit(c.rules)}, ${jsonLit(c.schema)},
               ${jsonLit(c.fields)}, ${jsonLit(c.indexes)}, ${v2cols(c)});`,
    );
  }
  for (const c of plan.collections.change) {
    parts.push(
      `update zsite.collections set rules = ${jsonLit(c.rules)}, schema = ${jsonLit(c.schema)},
              fields = ${jsonLit(c.fields)}, indexes = ${jsonLit(c.indexes)},
              recipient = ${nullable(defValue(c, "recipient"))}, uniques = ${jsonLit(defValue(c, "unique"))},
              states = ${nullable(defValue(c, "states"))}, "references" = ${jsonLit(defValue(c, "references"))},
              archived_at = null, updated_at = now()
        where site_id = ${s} and name = ${nameLit(c.name)};`,
    );
  }
  if (plan.collections.archive.length) {
    parts.push(
      `update zsite.collections set archived_at = now(), updated_at = now()
        where site_id = ${s} and archived_at is null and name in (${plan.collections.archive.map(nameLit).join(", ")});`,
    );
  }
  if (plan.contract.changed || !currentContract) {
    const d = plan.contract.desired;
    parts.push(
      `insert into zsite.site_contracts (site_id, schema_version, roles, capabilities, actions, aggregates, updated_at)
       values (${s}, ${d.schema_version === 2 ? 2 : 1}, ${jsonLit(d.roles)}, ${jsonLit(d.capabilities)},
               ${jsonLit(d.actions)}, ${jsonLit(d.aggregates)}, now())
       on conflict (site_id) do update set schema_version = excluded.schema_version, roles = excluded.roles,
         capabilities = excluded.capabilities, actions = excluded.actions, aggregates = excluded.aggregates, updated_at = now();`,
    );
  }
  parts.push("commit;");
  return parts.join("\n");
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function refusalFromError(e: unknown): SiteContractRefused | null {
  const m = String((e as Error)?.message ?? e);
  const j = /zavi_refused (\{.*\})/s.exec(m);
  if (j) {
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(j[1]) as Record<string, unknown>;
    } catch {
      return new SiteContractRefused("refused", "the database refused the new contract");
    }
    const n = Number(d.records ?? 0);
    const col = String(d.collection ?? "");
    switch (d.code) {
      case "lease_lost":
        return new SiteContractRefused("lease_lost", "This publish no longer holds its commit lease, so its data model change was not applied.", d);
      case "unique_duplicates":
        return new SiteContractRefused(
          "unique_duplicates",
          `${plural(n, "record")} in "${col}" share the same ${(d.fields as string[] | undefined)?.join(" + ") ?? "values"} ` +
            `(${plural(Number(d.groups ?? 0), "duplicate group")}), so that combination cannot be made unique yet. ` +
            `Nothing was changed. Remove or edit the duplicates first, or drop this unique rule.`,
          d,
        );
      case "invalid_states":
        return new SiteContractRefused(
          "invalid_states",
          `${plural(n, "record")} in "${col}" have a ${String(d.field)} that is not one of ${((d.values as string[]) ?? []).join(", ")}. ` +
            `Nothing was changed. Add those values to the state list, or fix the records first.`,
          d,
        );
      case "broken_references":
        return new SiteContractRefused(
          "broken_references",
          `${plural(n, "record")} in "${col}" point ${String(d.field)} at a ${String(d.target)} record that does not exist. ` +
            `Nothing was changed (they are never cleared silently). Fix or remove those references first.`,
          d,
        );
      case "recipient_unresolvable":
        return new SiteContractRefused(
          "recipient_unresolvable",
          `${plural(n, "record")} in "${col}" point ${String(d.field)} at a ${String(d.target)} record that is missing or has no owner, ` +
            `so their recipient cannot be derived. Nothing was changed.`,
          d,
        );
      case "action_bounds":
        return new SiteContractRefused(
          "action_bounds",
          `${plural(n, "record")} in "${col}" have a ${String(d.field)} outside the bounds of action "${String(d.action)}". Nothing was changed.`,
          d,
        );
      default:
        return new SiteContractRefused(String(d.code ?? "refused"), "the database refused the new contract", d);
    }
  }
  const code = /\b(field_not_writable|invalid_action_input|invalid_idempotency_key|cascade_too_large|reference_restricted)\b(?::\s*([a-z0-9_]+))?/.exec(m);
  if (code) {
    const what = code[2] ? ` (${code[2]})` : "";
    const reasons: Record<string, string> = {
      field_not_writable: `The database would not let existing records be changed${what}: that field is protected. Nothing was changed.`,
      invalid_action_input: `An action's input does not match its declaration${what}. Nothing was changed.`,
      invalid_idempotency_key: `A stored record carries an invalid idempotency key${what}. Nothing was changed.`,
      cascade_too_large: `Deleting would affect more than 1,000 dependent records${what}. Nothing was changed; delete in smaller steps.`,
      reference_restricted: `Other records still point at a record that would be removed${what}. Nothing was changed; remove those references first.`,
    };
    return new SiteContractRefused(code[1], reasons[code[1]], code[2] ? { field: code[2] } : {});
  }
  if (/duplicate key value|unique_violation|23505/.test(m)) {
    return new SiteContractRefused("unique_duplicates", "Existing records conflict with a new unique rule. Nothing was changed. Remove the duplicates first, or drop the rule.");
  }
  if (/collections_valid|violates check constraint/.test(m)) {
    return new SiteContractRefused("invalid_definition", "the database rejected a collection definition (rules, schema, fields, indexes or relational fields)");
  }
  return null;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export async function readCollectionsV2(sql: ShardSql, ref: string, site_id: string): Promise<CollectionDef[]> {
  const rows = (await sql.query(
    ref,
    `select name, kind, rules, schema, fields, indexes, archived_at is not null as archived,
            recipient, uniques, states, "references" from zsite.collections
      where site_id = ${uuidLit(site_id)} order by name collate "C"`,
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    name: String(r.name),
    kind: r.kind === "files" ? "files" : "records",
    rules: obj(r.rules) as Record<string, string[]>,
    schema: obj(r.schema),
    fields: obj(r.fields),
    indexes: obj(r.indexes),
    archived: r.archived === true,
    recipient: r.recipient && typeof (r.recipient as { reference?: unknown }).reference === "string" ? (r.recipient as { reference: string }) : null,
    unique: Array.isArray(r.uniques) ? (r.uniques as CollectionDef["unique"]) : [],
    states: r.states && typeof r.states === "object" ? (r.states as CollectionDef["states"]) : null,
    references: obj(r.references) as CollectionDef["references"],
  }));
}

export async function readSiteContract(sql: ShardSql, ref: string, site_id: string): Promise<SiteContractDef | null> {
  const rows = (await sql.query(
    ref,
    `select schema_version, roles, capabilities, actions, aggregates from zsite.site_contracts where site_id = ${uuidLit(site_id)}`,
  )) as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
  return {
    schema_version: Number(r.schema_version) === 2 ? 2 : 1,
    roles: strings(r.roles),
    capabilities: strings(r.capabilities),
    actions: obj(r.actions) as SiteContractDef["actions"],
    aggregates: obj(r.aggregates) as SiteContractDef["aggregates"],
  };
}

export async function roleHolders(sql: ShardSql, ref: string, site_id: string, roles: string[]): Promise<RoleHolder[]> {
  if (!roles.length) return [];
  const rows = (await sql.query(
    ref,
    `select user_id::text as user_id, role from zsite.members
      where site_id = ${uuidLit(site_id)} and role in (${roles.map(nameLit).join(", ")})
      order by (user_id::text || role) collate "C"`,
  )) as Array<{ user_id?: string; role?: string }>;
  return rows.map((r) => ({ user_id: String(r.user_id), role: String(r.role) }));
}
