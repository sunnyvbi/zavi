
export type Dialect = "postgres" | "mysql" | "mongodb" | "dynamodb";

export type RefusedBy = "zavi" | "connector";

export type Refusal = { ok: false; reason: string; refused_by?: RefusedBy; rule?: "settings" };

export type GuardResult<T> = ({ ok: true } & T) | Refusal;

export type { CatalogColumnLike, CatalogTable, CatalogLike, Policy, PolicyRow, ConnectorRules } from "./policy";
