import { structuredClass } from "./pg-structured";

function columnTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

const SUBSTRING =
  /(e?mail|phone|mobile|address|street|postal|post.?code|zip.?code|first.?name|last.?name|full.?name|surname|given.?name|licen[cs]e(?!.?plate)|social.?security|date.?of.?birth|birth.?date|pass(word|wd)?|passport|national.?id|gov(t|ernment)?.?id|geo.?ip|device.?id|fingerprint|bank.?account|secret|token|credential|api.?key|private.?key|account.?number|routing|tax.?id|msisdn|telephone)/i;
const DL_NUMBER = /(^|[^a-z])dl.?number/i;

const TOKENS = new Set(["ssn", "dob", "card", "cvv", "cvc", "iban", "bank", "tel", "cell", "nid", "zip", "ip"]);
const TOKEN_EXEMPT = new Set(["balance", "count", "type", "brand"]);

const PERSON_ROLE =
  /(owner|contact|renter|guest|host|customer|user|driver|billing|shipping|recipient|holder|card|account|member|parent|emergency)/i;

const PERSON_TABLE = /^(users?|customers?|accounts?|members?|guests?|hosts?|profiles?|contacts?|people|persons?)(_for_zavi)?$/i;

function leafOf(name: string): string {
  const parts = name.split(".");
  return parts[parts.length - 1] ?? name;
}

export function isSensitiveField(table: string, field: string): boolean {
  const last = leafOf(field);
  if (SUBSTRING.test(field) || DL_NUMBER.test(field)) return true;
  const toks = columnTokens(field);
  if (toks.some((t) => TOKENS.has(t)) && !toks.some((t) => TOKEN_EXEMPT.has(t))) return true;
  if (toks.some((t) => t === "name" || t === "names") && PERSON_ROLE.test(field)) return true;
  if (last.toLowerCase() === "name" && PERSON_TABLE.test(leafOf(table))) return true;
  return false;
}

export function sensitiveKind(field: string): string {
  const f = field.toLowerCase();
  const toks = columnTokens(field);
  if (/e?mail/.test(f)) return "Email address";
  if (/phone|mobile|telephone|msisdn/.test(f) || toks.some((t) => t === "tel" || t === "cell")) return "Phone number";
  if (toks.some((t) => t === "card" || t === "cvv" || t === "cvc") && !toks.includes("name")) return "Card digits";
  if (/address|street|postal|post.?code|zip/.test(f)) return "Street address";
  if (/licen[cs]e|(^|[^a-z])dl.?number/.test(f)) return "Licence";
  if (/date.?of.?birth|birth.?date/.test(f) || toks.includes("dob")) return "Date of birth";
  if (
    /social.?security|tax.?id|account.?number|routing|passport|national.?id|gov(t|ernment)?.?id|bank.?account/.test(f) ||
    toks.some((t) => t === "ssn" || t === "iban" || t === "bank" || t === "nid")
  )
    return "ID number";
  if (/geo.?ip|device.?id|fingerprint/.test(f) || toks.includes("ip")) return "Device or network ID";
  if (/pass(word|wd)?|secret|token|credential|api.?key|private.?key/.test(f)) return "Secret";
  if (/name/.test(f)) return "Person's name";
  return "Secret";
}

export type SensitiveColumnLike = {
  name: string;
  type?: string;
  json_keys?: string[];
  json_sampled?: "full" | "partial" | "none";
  json_map_like?: boolean;
};

export function sensitiveJsonKeys(table: string, column: SensitiveColumnLike): string[] {
  return (column.json_keys ?? []).filter((k) => k.split(".").some((seg) => seg.length > 0 && isSensitiveField(table, seg)));
}

export function jsonColumnUnchecked(column: SensitiveColumnLike): "unchecked" | "map_like" | null {
  const cls = structuredClass(column.type);
  if (cls === null && column.json_sampled === undefined) return null;
  if (cls === "unknown") return "unchecked";
  if (column.json_map_like) return "map_like";
  if (column.json_sampled !== "full") return "unchecked";
  return null;
}

export function isOpaqueStructuredColumn(column: SensitiveColumnLike): boolean {
  const cls = structuredClass(column.type);
  return cls === "hstore" || cls === "composite" || cls === "unknown";
}

export function isSensitiveColumn(table: string, column: SensitiveColumnLike): boolean {
  return isSensitiveField(table, column.name) || isOpaqueStructuredColumn(column) || jsonColumnUnchecked(column) !== null || sensitiveJsonKeys(table, column).length > 0;
}

const listKeys = (keys: string[]) => `${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", ..." : ""}`;

export function sensitiveColumnKind(table: string, column: SensitiveColumnLike): string {
  if (isSensitiveField(table, column.name)) return sensitiveKind(column.name);
  const cls = structuredClass(column.type);
  if (cls === "hstore") return column.json_keys && column.json_keys.length > 0 ? `hstore column: contains ${listKeys(column.json_keys)}` : "hstore column";
  if (cls === "composite") return column.json_keys && column.json_keys.length > 0 ? `Custom type: ${listKeys(column.json_keys)}` : "Custom type";
  if (cls === "unknown") return "Custom type: Zavi couldn't check what's inside";
  const why = jsonColumnUnchecked(column);
  if (why === "map_like") return "Keys look like customer data";
  if (why === "unchecked") return "Zavi couldn't check what's inside";
  const leaves = [...new Set(sensitiveJsonKeys(table, column).map((k) => k.split(".").pop()!))];
  return leaves.length > 0 ? `Contains ${leaves.slice(0, 3).join(", ")}${leaves.length > 3 ? ", ..." : ""}` : sensitiveKind(column.name);
}
