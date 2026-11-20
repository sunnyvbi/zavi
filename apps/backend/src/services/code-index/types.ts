
export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "var"
  | "struct"
  | "enum"
  | "extension"
  | "protocol"
  | "object";

export interface SymbolRow {
  symbol_name: string;
  kind: SymbolKind;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
}

export type RefKind = "reference" | "call";

export interface RefRow {
  symbol_name: string;
  ref_kind: RefKind;
  from_symbol: string | null;
  file_path: string;
  line: number;
}

export interface ExtractResult {
  symbols: SymbolRow[];
  refs: RefRow[];
}
