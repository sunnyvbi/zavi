
export type ColType =
  | "pk"
  | "int"
  | "bigint"
  | "text"
  | "bool"
  | "timestamp"
  | "date"
  | "numeric"
  | "json";

export type Table = {
  name: string;
  columns: { name: string; type: ColType; nullable?: boolean; forwardLooking?: boolean }[];
  rows: Record<string, unknown>[];
};

export type Dataset = {
  shape: string;
  business: string;
  anchorIso: string;
  timezone: string;
  tables: Table[];
};

export function table(
  name: string,
  columns: Table["columns"],
  rows: Record<string, unknown>[],
): Table {
  return { name, columns, rows };
}
