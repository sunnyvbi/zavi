export const DB_TOOL_NAME_SQL_REGEX = "(^|__)operator_db(__|_)";
const RE = new RegExp(DB_TOOL_NAME_SQL_REGEX);

export function isDbToolName(name: string | null | undefined): boolean {
  return typeof name === "string" && RE.test(name);
}
