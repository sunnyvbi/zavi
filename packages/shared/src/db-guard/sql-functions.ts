import type { SqlDialect } from "./sql-lexer";

const COMMON = [
  "count", "sum", "avg", "min", "max", "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp",
  "coalesce", "nullif", "greatest", "least", "abs", "round", "ceil", "ceiling", "floor", "mod", "power", "sqrt",
  "ln", "log", "exp", "sign", "lower", "upper", "length", "char_length", "trim", "ltrim", "rtrim", "substring",
  "substr", "left", "right", "replace", "concat", "concat_ws", "lpad", "rpad", "cast", "extract", "now",
  "current_date", "current_timestamp", "date",
  "row_number", "rank", "dense_rank", "lag", "lead", "first_value", "last_value", "ntile",
];
const POSTGRES = [
  "percentile_cont", "percentile_disc", "mode", "bool_and", "bool_or", "every", "array_agg", "string_agg",
  "json_agg", "jsonb_agg", "row_to_json", "to_json", "to_jsonb", "json_build_object", "jsonb_build_object",
  "trunc", "initcap", "position", "strpos", "split_part", "date_trunc", "date_part", "to_char", "to_date",
  "to_timestamp", "age", "make_interval", "random", "array_length", "unnest", "jsonb_array_length",
  "json_array_length", "jsonb_extract_path_text", "json_extract_path_text", "jsonb_typeof", "json_typeof",
  "convert_from", "decode", "encode",
];
const MYSQL = [
  "group_concat", "truncate", "locate", "instr", "datediff", "date_format", "date_add", "date_sub", "timestampdiff",
  "year", "month", "day", "week", "hour", "minute", "dayofweek", "unix_timestamp", "from_unixtime", "if", "ifnull",
  "rand", "str_to_date", "curdate", "json_extract", "json_unquote",
  "convert", "convert_tz", "yearweek", "weekofyear", "dayofmonth", "quarter", "utc_timestamp", "timestamp",
];

const ALLOW: Record<SqlDialect, Set<string>> = {
  postgres: new Set([...COMMON, ...POSTGRES]),
  mysql: new Set([...COMMON, ...MYSQL]),
};

export function isAllowedFunction(name: string, dialect: SqlDialect): boolean {
  return ALLOW[dialect].has(name.toLowerCase());
}
