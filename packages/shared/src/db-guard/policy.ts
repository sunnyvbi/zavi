import { isOpaqueStructuredColumn, isSensitiveColumn } from "./sensitive";
import type { Dialect } from "./types";

export type PolicyRow = {
  auto_hide: boolean;
  hidden_fields: string[];
  unhidden_fields: string[];
  disabled_tables: string[];
};
export type CatalogColumnLike = {
  name: string;
  type?: string;
  json_keys?: string[];
  json_sampled?: "full" | "partial" | "none";
  json_map_like?: boolean;
};
export type CatalogTable = {
  name: string;
  columns: CatalogColumnLike[];
  view_of?: string;
  partitioned?: boolean;
  partitions?: string[];
  parents?: string[];
};
export type CatalogLike = { tables: CatalogTable[] };

export type Policy = {
  dialect: Dialect | null;
  allowed: Map<string, CatalogTable>;
  hiddenByTable: Map<string, Set<string>>;
  resolve(table: string, quoted?: boolean): CatalogTable | null;
  isAllowed(table: string, quoted?: boolean): boolean;
  isHidden(table: string, field: string): boolean;
  hiddenFields(table: string): string[];
  unhiddenFields(table: string): string[];
  visibleColumns(table: string): string[];
};

export type ConnectorRules = {
  allowed: string[];
  blocked: string[];
  allowed_columns?: string[];
  what_can_leave: "totals_and_counts_only" | "rows_without_blocked_columns";
  max_rows: number;
};

const lc = (s: string) => s.toLowerCase();

function restrictionRefs(entries: string[], catalog: CatalogLike): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (table: string, field: string) => {
    if (!field) return;
    const list = out.get(table) ?? [];
    list.push(field);
    out.set(table, list);
  };
  for (const raw of entries) {
    const e = raw.trim();
    for (const t of catalog.tables) {
      if (lc(e).startsWith(lc(t.name) + ".")) add(t.name, e.slice(t.name.length + 1));
    }
  }
  return out;
}

function permissionRefs(entries: string[], catalog: CatalogLike): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const raw of entries) {
    const e = raw.trim();
    let best: string | null = null;
    for (const t of catalog.tables) {
      if (e.startsWith(t.name + ".") && (!best || t.name.length > best.length)) best = t.name;
    }
    if (!best) continue;
    const field = e.slice(best.length + 1);
    if (!field) continue;
    const list = out.get(best) ?? [];
    list.push(field);
    out.set(best, list);
  }
  return out;
}

function build(
  catalog: CatalogLike,
  dialect: Dialect | null,
  isTableAllowed: (t: CatalogTable) => boolean,
  hidden: (t: CatalogTable) => Set<string>,
  unhidden: (t: CatalogTable) => string[] = () => [],
): Policy {
  const all = new Map<string, CatalogTable>(catalog.tables.map((t) => [t.name, t]));
  const parentNames = new Map<string, Set<string>>();
  const addParent = (child: string, parent: string) => {
    const set = parentNames.get(child) ?? new Set<string>();
    set.add(parent);
    parentNames.set(child, set);
  };
  for (const p of catalog.tables) {
    if (p.partitioned) for (const part of p.partitions ?? []) addParent(part, p.name);
    for (const parent of p.parents ?? []) addParent(p.name, parent);
  }
  const parentsOf = (name: string): CatalogTable[] | null => {
    const out: CatalogTable[] = [];
    for (const n of parentNames.get(name) ?? []) {
      if (n === name) return null;
      const t = all.get(n);
      if (!t) return null;
      out.push(t);
    }
    return out;
  };
  const ownAllowed = (t: CatalogTable) => isTableAllowed(t) && !t.view_of;
  const allowed = new Map<string, CatalogTable>();
  for (const t of catalog.tables) {
    if (!ownAllowed(t)) continue;
    const parents = parentsOf(t.name);
    if (parents === null || parents.some((p) => !ownAllowed(p))) continue;
    allowed.set(t.name, t);
  }
  const ciMatches = (name: string) => catalog.tables.filter((t) => lc(t.name) === lc(name));
  const resolveName = (table: string, quoted: boolean): string | null => {
    if (dialect === "postgres") {
      const n = quoted ? table : lc(table);
      return all.has(n) ? n : null;
    }
    if (dialect === "mysql" && !quoted) {
      if (all.has(table)) return table;
      const m = ciMatches(table);
      return m.length === 1 ? m[0]!.name : null;
    }
    return all.has(table) ? table : null;
  };
  const hiddenOrig = new Map<string, string[]>();
  const hiddenByTable = new Map<string, Set<string>>();
  for (const [k, t] of allowed) {
    const own = hidden(t);
    const merged = new Map<string, string>([...own].map((f) => [lc(f), f]));
    for (const p of parentsOf(t.name) ?? []) for (const f of hidden(p)) if (!merged.has(lc(f))) merged.set(lc(f), f);
    const h = [...merged.values()];
    if (h.length === 0) continue;
    hiddenOrig.set(k, h);
    hiddenByTable.set(k, new Set(h.map(lc)));
  }
  const resolve = (table: string, quoted = false): CatalogTable | null => {
    const n = resolveName(table, quoted);
    return n === null ? null : (allowed.get(n) ?? null);
  };
  const key = (table: string): string | null => (allowed.has(table) ? table : (resolve(table)?.name ?? null));
  return {
    dialect,
    allowed,
    hiddenByTable,
    resolve,
    isAllowed: (table, quoted) => resolve(table, quoted) !== null,
    isHidden: (table, field) => {
      const k = key(table);
      return k !== null && (hiddenByTable.get(k)?.has(lc(field)) ?? false);
    },
    hiddenFields: (table) => {
      const k = key(table);
      return k === null ? [] : (hiddenOrig.get(k) ?? []);
    },
    unhiddenFields: (table) => {
      const k = key(table);
      return k === null ? [] : unhidden(allowed.get(k)!);
    },
    visibleColumns: (table) => {
      const k = key(table);
      if (k === null) return [];
      const h = hiddenByTable.get(k);
      return allowed.get(k)!.columns.map((c) => c.name).filter((n) => !h?.has(lc(n)));
    },
  };
}

export function effectivePolicy(row: PolicyRow, catalog: CatalogLike, dialect: Dialect | null = null): Policy {
  const disabled = new Set(row.disabled_tables.map((t) => lc(t.trim())));
  const hiddenRefs = restrictionRefs(row.hidden_fields, catalog);
  const unhiddenRefs = permissionRefs(row.unhidden_fields, catalog);
  const hiddenLeaves = new Set(row.hidden_fields.map((h) => lc(h.trim().split(".").pop() ?? "")).filter(Boolean));
  return build(
    catalog,
    dialect,
    (t) => !disabled.has(lc(t.name)),
    (t) => {
      const out = new Map<string, string>();
      if (row.auto_hide) {
        for (const c of t.columns) {
          const keyHidden = (c.json_keys ?? []).some((k) => k.split(".").some((seg) => hiddenLeaves.has(lc(seg))));
          if (isSensitiveColumn(t.name, c) || keyHidden) out.set(lc(c.name), c.name);
        }
      }
      for (const c of t.columns) if (isOpaqueStructuredColumn(c)) out.set(lc(c.name), c.name);
      for (const f of hiddenRefs.get(t.name) ?? []) out.set(lc(f), f);
      const unExact = new Set(unhiddenRefs.get(t.name) ?? []);
      for (const [k, name] of [...out]) if (unExact.has(name)) out.delete(k);
      return new Set(out.values());
    },
    (t) => unhiddenRefs.get(t.name) ?? [],
  );
}

export function policyFromRules(rules: ConnectorRules, catalog: CatalogLike, dialect: Dialect | null = null): Policy {
  const allowedNames = new Set(rules.allowed.map((t) => t.trim()));
  const blocked = restrictionRefs(rules.blocked, catalog);
  const allowedCols = permissionRefs(rules.allowed_columns ?? [], catalog);
  return build(
    catalog,
    dialect,
    (t) => allowedNames.has(t.name),
    (t) => {
      const out = new Set(blocked.get(t.name) ?? []);
      const explicit = new Set(allowedCols.get(t.name) ?? []);
      for (const c of t.columns) if (isOpaqueStructuredColumn(c) && !explicit.has(c.name)) out.add(c.name);
      return out;
    },
  );
}
