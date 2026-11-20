
export type EvalDialect = "postgres" | "mysql" | "mongodb";

export const EVAL_DIALECTS: EvalDialect[] = ["postgres", "mysql", "mongodb"];

const BASE_ENV: Record<EvalDialect, string> = {
  postgres: "EVAL_OPDB_POSTGRES_URL",
  mysql: "EVAL_OPDB_MYSQL_URL",
  mongodb: "EVAL_OPDB_MONGO_URL",
};

export function baseUrl(dialect: EvalDialect): string | undefined {
  const v = process.env[BASE_ENV[dialect]];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

export function evalDbName(shape: string): string {
  return `zavi_eval_${shape}`;
}

export function dbUrlFor(dialect: EvalDialect, shape: string): string | undefined {
  const base = baseUrl(dialect);
  if (!base) return undefined;
  const url = new URL(base);
  url.pathname = `/${evalDbName(shape)}`;
  return url.toString();
}

export function configuredDialects(): EvalDialect[] {
  return EVAL_DIALECTS.filter((d) => baseUrl(d) !== undefined);
}

export const HAS_ANY_DB = (): boolean => configuredDialects().length > 0;
