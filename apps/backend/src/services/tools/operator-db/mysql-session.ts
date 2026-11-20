import { clampStatementTimeoutMs } from "@zavi/shared/db-guard";

export type StatementTimeoutApplied = "mysql" | "mariadb" | "none";

export async function applyMysqlStatementTimeout(
  query: (sql: string) => Promise<unknown>,
  rawTimeoutMs: number,
): Promise<StatementTimeoutApplied> {
  const timeoutMs = clampStatementTimeoutMs(rawTimeoutMs);
  try {
    await query(`SET SESSION MAX_EXECUTION_TIME = ${Math.round(timeoutMs)}`);
    return "mysql";
  } catch {
    try {
      await query(`SET SESSION max_statement_time = ${timeoutMs / 1000}`);
      return "mariadb";
    } catch {
      return "none";
    }
  }
}
